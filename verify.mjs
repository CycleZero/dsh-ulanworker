/**
 * Offline checks for the bundled skill loader.
 *
 * Two layers:
 *
 *  1. An integration pass runs `apply()` against a stub context, so the exact
 *     registration payload a live session would receive can be inspected
 *     without installing the bundle.
 *  2. Unit passes drive `buildRegistration()` over temporary fixtures for the
 *     cases the shipped files do not exercise: invocation policy, rejected
 *     spellings, legacy keys, missing frontmatter, missing description. The
 *     fixtures are created under the OS temp directory and removed before exit.
 *
 * Usage: `node verify.mjs`
 *
 * @module dsh-ulanworker/verify
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, buildRegistration, inject, name } from './index.js'

const ROOT = dirname(fileURLToPath(import.meta.url))
const EXPECTED = ['handoff', 'ultrawork']

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

// ---------------------------------------------------------------- integration

const registered = []
const warnings = []
const ctx = {
  logger: { warn: (message) => warnings.push(String(message)) },
  skills: {
    register(skill) {
      registered.push(skill)
      return () => {}
    },
  },
  effect(callback, label) {
    if (typeof label !== 'string' || label === '') throw new Error('ctx.effect called without a label')
    return callback()
  },
}

apply(ctx, undefined)

check(inject.length === 1 && inject[0] === 'skills', `inject must be ['skills'], got ${JSON.stringify(inject)}`)
check(name === 'dsh-ulanworker', `unexpected plugin name ${name}`)
check(warnings.length === 0, `unexpected warnings: ${warnings.join(' | ')}`)
check(
  registered.map((skill) => skill.name).sort().join(',') === EXPECTED.join(','),
  `registered ${JSON.stringify(registered.map((skill) => skill.name))}, expected ${JSON.stringify(EXPECTED)}`,
)

for (const skill of registered) {
  const directory = join(ROOT, 'skills', skill.name)
  const file = join(directory, 'SKILL.md')
  check(existsSync(file), `${skill.name}: ${file} does not exist`)
  const raw = readFileSync(file, 'utf8')
  const body = raw.slice(raw.indexOf('\n---', 4) + 4).replace(/^\n+/, '')
  check(typeof skill.description === 'string' && skill.description.length >= 20, `${skill.name}: description missing or too short`)
  check(typeof skill.whenToUse === 'string' && skill.whenToUse.length > 0, `${skill.name}: whenToUse was not parsed`)
  check(
    skill.metadata !== undefined && typeof skill.metadata['short-description'] === 'string',
    `${skill.name}: nested metadata map was not parsed`,
  )
  check(skill.content === body, `${skill.name}: registered body does not match the file body (frontmatter must be stripped)`)
  check(skill.source === 'runtime', `${skill.name}: source must be 'runtime'`)
  check(skill.path === file, `${skill.name}: path must point at its own SKILL.md`)
  check(
    skill.resourceBase?.kind === 'directory' && skill.resourceBase?.path === directory,
    `${skill.name}: resourceBase must be its own directory`,
  )
  check(
    skill.invocation?.modelInvocable === true && skill.invocation?.userInvocable === true,
    `${skill.name}: shipped skills must stay invocable from both surfaces`,
  )
  console.log(
    `${skill.name.padEnd(10)} desc=${String(skill.description.length).padStart(3)} body=${String(skill.content.length).padStart(5)} chars  invocation=model+user  ${skill.path}`,
  )
}

// --------------------------------------------------------------------- units

const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-ulanworker-verify-'))
try {
  const writeFixture = (label, text) => {
    const directory = join(fixtureRoot, label)
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'SKILL.md')
    writeFileSync(file, text)
    return { directory, file }
  }

  const accepted = [
    [
      'policy-model-off',
      '---\nname: x\ndescription: a routed skill\ndisable-model-invocation: true\n---\nbody\n',
      (skill) => skill.invocation.modelInvocable === false && skill.invocation.userInvocable === true,
    ],
    [
      'policy-user-off',
      '---\nname: x\ndescription: a routed skill\nuser-invocable: "no"\n---\nbody\n',
      (skill) => skill.invocation.modelInvocable === true && skill.invocation.userInvocable === false,
    ],
    [
      'policy-on',
      '---\nname: x\ndescription: a routed skill\nuser-invocable: ON\n---\nbody\n',
      (skill) => skill.invocation.userInvocable === true,
    ],
  ]
  for (const [label, text, assertion] of accepted) {
    const written = writeFixture(label, text)
    const result = buildRegistration(written.file, written.directory, label)
    check(result.skill !== undefined, `${label}: expected a skill, got warning "${result.warning}"`)
    if (result.skill !== undefined) check(assertion(result.skill), `${label}: invocation policy did not match the frontmatter`)
  }

  const rejected = [
    ['legacy-key', '---\nname: x\ndescription: a routed skill\nmodelInvocable: false\n---\nbody\n', /unsupported/],
    ['bad-boolean', '---\nname: x\ndescription: a routed skill\nuser-invocable: maybe\n---\nbody\n', /must be a boolean/],
    ['no-description', '---\nname: x\n---\nbody\n', /needs non-empty name and description/],
    ['no-frontmatter', 'just a body\n', /no YAML frontmatter/],
  ]
  for (const [label, text, pattern] of rejected) {
    const written = writeFixture(label, text)
    const result = buildRegistration(written.file, written.directory, label)
    check(result.skill === undefined, `${label}: expected a skip, got a registration`)
    check(
      result.warning !== undefined && pattern.test(result.warning),
      `${label}: warning "${result.warning}" does not match ${pattern}`,
    )
  }

  const missing = buildRegistration(join(fixtureRoot, 'nope', 'SKILL.md'), join(fixtureRoot, 'nope'), 'nope')
  check(
    missing.skill === undefined && /cannot read/.test(String(missing.warning)),
    'missing file: expected a "cannot read" warning',
  )
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true })
}
check(!existsSync(fixtureRoot), 'temp fixture directory was not removed')

if (failures.length > 0) {
  console.error('\nFAIL')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nPASS: bundled skills register with a complete payload; invocation policy and rejection paths behave')
