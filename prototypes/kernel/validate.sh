#!/usr/bin/env bash
# validate.sh — proves THE CORE RULE by construction, then typechecks, then
# runs the universality demo.
#
# The grep gate is meaningful, not decorative: the kernel MUST NOT branch on
# what a capability is. We forbid, in kernel.ts + types.ts only:
#   1. any switch statement at all (kernel dispatch must be table-driven over
#      closed protocol discriminants),
#   2. equality dispatch on `kind`/`type` fields,
#   3. capability-classification vocabulary (category/capabilityKind/...),
#   4. instanceof checks against provider classes,
#   5. any quoted capability name or capability-family word appearing in
#      kernel source (the kernel may never name a capability).
# Providers and the demo are intentionally NOT restricted — differences belong
# in manifests and provider behaviour, which is the whole point.
set -euo pipefail
cd "$(dirname "$0")"

KERNEL_FILES="kernel.ts types.ts"
fail=0

check() {
  local label="$1" pattern="$2"
  if grep -nEi "$pattern" $KERNEL_FILES; then
    echo "FORBIDDEN ($label): pattern '$pattern' matched above"
    fail=1
  else
    echo "  ok: $label"
  fi
}

echo "== [1/3] no-type-dispatch grep gate over $KERNEL_FILES =="
check "no switch statements (dispatch must be table-driven)" '\bswitch\b'
check "no equality dispatch on kind" '\bkind[[:space:]]*[!=]=='
check "no equality dispatch on type" '\btype[[:space:]]*[!=]=='
check "no capability-classification vocabulary" '\b(category|capabilitykind|capabilitytype|providertype|providerkind)\b'
check "no instanceof-provider dispatch" 'instanceof[[:space:]]+[A-Za-z]*provider'
check "kernel never names a capability" "'(mock-llm|calculator|mock-mcp|coding-agent|graph-strategy|remote-a2a|human-approval|local-model|llm|mcp|a2a)'"
if [ "$fail" -ne 0 ]; then
  echo "GREP GATE: FAIL"
  exit 1
fi
echo "GREP GATE: PASS"

echo
echo "== [2/3] npx tsc --noEmit (strict) =="
(cd .. && npx tsc --noEmit)
echo "TYPECHECK: PASS"

echo
echo "== [3/3] demo-universality =="
node --experimental-strip-types demo-universality.ts
echo
echo "validate.sh: ALL GATES PASS"
