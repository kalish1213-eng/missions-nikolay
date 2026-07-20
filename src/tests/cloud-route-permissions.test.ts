import { describe, expect, it } from 'vitest'
import { canPerform } from '../cloud/permissions'
import { buildChildInviteUrl, parseHashRoute } from '../cloud/routes'
import type { CloudRole } from '../types/cloud'

describe('cloud hash routes', () => {
  it.each([
    ['', { kind: 'landing' }],
    ['#/', { kind: 'landing' }],
    ['#/parent', { kind: 'parent' }],
    ['#/child', { kind: 'child' }],
    ['#/local', { kind: 'local' }],
    ['#/setup', { kind: 'parent' }],
  ] as const)('parses %s without relying on browser state', (hash, expected) => {
    expect(parseHashRoute(hash)).toEqual(expected)
  })

  it('accepts a URL-safe one-time invite token', () => {
    const token = 'invite_token.2026-07~nikolay'

    expect(parseHashRoute(`#/invite/${token}`)).toEqual({ kind: 'join', inviteToken: token })
  })

  it.each([
    '#/invite/short',
    '#/invite/%3Cscript%3E-not-safe-token',
    '#/invite/token-with-encoded-slash%2Fmore',
    '#/invite/%',
    '#/invite/valid-looking-token-12345/extra',
  ])('does not expose an invalid invite as a join route: %s', (hash) => {
    expect(parseHashRoute(hash)).toEqual({ kind: 'not-found' })
  })

  it('builds an invite URL on the current Pages path and discards an old hash', () => {
    const token = 'invite_token.2026-07~nikolay'
    const inviteUrl = buildChildInviteUrl(
      'https://example.github.io/missions-nikolay/?old=value#/parent',
      token,
    )

    expect(inviteUrl).toBe(
      `https://example.github.io/missions-nikolay/#/join/${token}`,
    )
    expect(parseHashRoute(new URL(inviteUrl).hash)).toEqual({ kind: 'join', inviteToken: token })
  })

  it('refuses to put an unsafe token into a shareable URL', () => {
    expect(() =>
      buildChildInviteUrl('https://example.github.io/missions-nikolay/', 'too-short'),
    ).toThrow()
  })
})

describe('cloud UI permissions', () => {
  const expected: Record<'anonymous' | CloudRole, ReadonlySet<string>> = {
    anonymous: new Set(['create_family', 'claim_child_invite']),
    parent: new Set([
      'get_family_snapshot',
      'create_child_invite',
      'review_task',
      'undo_approval',
      'add_custom_task',
      'update_task',
      'update_family_settings',
      'adjust_xp',
      'reset_today',
      'change_parent_pin',
      'revoke_child_device',
      'delete_family',
    ]),
    child: new Set(['get_family_snapshot', 'submit_task', 'start_timer', 'stop_timer']),
  }

  const operations = [
    'create_family',
    'create_child_invite',
    'claim_child_invite',
    'get_family_snapshot',
    'submit_task',
    'review_task',
    'undo_approval',
    'add_custom_task',
    'update_task',
    'update_family_settings',
    'adjust_xp',
    'start_timer',
    'stop_timer',
    'reset_today',
    'change_parent_pin',
    'revoke_child_device',
    'delete_family',
  ] as const

  it.each([
    ['anonymous', null],
    ['parent', 'parent'],
    ['child', 'child'],
  ] as const)('uses a deny-by-default matrix for %s', (label, role) => {
    for (const operation of operations) {
      expect(canPerform(role, operation), `${label} / ${operation}`).toBe(
        expected[label].has(operation),
      )
    }
  })

  it('does not let an authenticated role reuse anonymous bootstrap or invite claims', () => {
    expect(canPerform('parent', 'create_family')).toBe(false)
    expect(canPerform('child', 'claim_child_invite')).toBe(false)
    expect(canPerform('child', 'delete_family')).toBe(false)
  })
})
