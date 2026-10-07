#!/usr/bin/env bash
#
# Freshness gate for a triage run. Run this from the superproject root before
# building a payload, and stamp the revision it prints into the payload.
#
#   ./modules/agents/github-issue-analyzer/triage/preflight.sh
#
# An analysis is a set of path:line citations, and a citation is only true of
# one tree. A run against a stale checkout produces line numbers that have
# already shifted, and it can call an issue relevant after the fix has landed.
# One run was judged against a checkout 49 commits behind origin/main; the judge
# caught it on a single issue, by luck, while every other analysis carried the
# same defect silently.
#
# Exit 1 means do not run. Pass --allow-stale to override, which is only
# reasonable when reproducing an earlier run at a known revision.

set -euo pipefail

ALLOW_STALE=0
[[ "${1:-}" == "--allow-stale" ]] && ALLOW_STALE=1

cd "$(git rev-parse --show-toplevel)"
fail=0

branch="$(git rev-parse --abbrev-ref HEAD)"
git fetch origin "$branch" --quiet

behind="$(git rev-list --count "HEAD..origin/$branch")"
ahead="$(git rev-list --count "origin/$branch..HEAD")"
printf 'superproject  %-28s behind=%s ahead=%s\n' "$branch" "$behind" "$ahead"
if [[ "$behind" -ne 0 ]]; then
  printf '  STALE: run `git pull --ff-only origin %s` first\n' "$branch"
  fail=1
fi

# A submodule checked out behind its pin is the failure mode `git pull` creates
# without --recurse-submodules: the superproject moves its pins, the submodule
# trees do not, and an agent then reads code older than the commit under test.
# Being ahead of the pin is different: that is local work, and blocking on it
# would make the gate unusable while developing in a submodule.
while read -r status path _; do
  case "$status" in
    -*) printf 'submodule     %-28s NOT INITIALIZED\n' "$path"; fail=1; continue ;;
    U*) printf 'submodule     %-28s MERGE CONFLICT\n' "$path"; fail=1; continue ;;
    +*) ;;
    *) continue ;;
  esac
  current="${status#+}"
  pinned="$(git ls-tree HEAD "$path" | awk '{print $3}')"
  if git -C "$path" merge-base --is-ancestor "$current" "$pinned" 2>/dev/null; then
    n="$(git -C "$path" rev-list --count "$current..$pinned" 2>/dev/null)"
    printf 'submodule     %-28s BEHIND its pin by %s commit(s)\n' "$path" "$n"
    printf '  STALE: run `git submodule update --init %s`\n' "$path"
    fail=1
  else
    printf 'submodule     %-28s ahead of its pin (local work, not stale)\n' "$path"
  fi
done < <(git submodule status --recursive 2>/dev/null || true)

# Agents are told to check whether a fix landed upstream in a submodule. That
# reads the submodule's remote-tracking refs, so they must be fetched or the
# answer is silently wrong.
while read -r path; do
  if git -C "$path" fetch --quiet 2>/dev/null; then
    printf 'submodule     %-28s remote refs fetched\n' "$path"
  else
    printf 'submodule     %-28s FETCH FAILED (upstream checks unreliable)\n' "$path"
    fail=1
  fi
done < <(git config --file .gitmodules --get-regexp '^submodule\..*\.path$' | awk '{print $2}')

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  printf '\nNOTE: tracked files are modified. Agents read the working tree, so the\n'
  printf '      citations they produce describe your edits, not %s.\n' "origin/$branch"
  git status --short --untracked-files=no | sed 's/^/      /'
fi

rev="$(git rev-parse --short HEAD)"
echo
if [[ "$fail" -ne 0 && "$ALLOW_STALE" -ne 1 ]]; then
  echo "PREFLIGHT FAILED. Fix the above, or pass --allow-stale to run anyway."
  exit 1
fi
[[ "$fail" -ne 0 ]] && echo "PREFLIGHT FAILED but --allow-stale given."
echo "revision=$rev"
echo "Stamp that into the payload so a result can be audited against the tree it was written for."
