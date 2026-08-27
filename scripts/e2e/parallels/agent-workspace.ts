// Agent Workspace script supports Afora repository automation.
export function posixAgentWorkspaceScript(purpose: string): string {
  return `set -eu
workspace="\${AFORA_WORKSPACE_DIR:-$HOME/.afora/workspace}"
mkdir -p "$workspace/.afora"
cat > "$workspace/IDENTITY.md" <<'IDENTITY_EOF'
# Identity

- Name: Afora
- Purpose: ${purpose}
IDENTITY_EOF
rm -f "$workspace/BOOTSTRAP.md"`;
}

export function windowsAgentWorkspaceScript(purpose: string): string {
  return `$workspace = $env:AFORA_WORKSPACE_DIR
if (-not $workspace) { $workspace = Join-Path $env:USERPROFILE '.afora\\workspace' }
$stateDir = Join-Path $workspace '.afora'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
@'
# Identity

- Name: Afora
- Purpose: ${purpose}
'@ | Set-Content -Path (Join-Path $workspace 'IDENTITY.md') -Encoding UTF8
Remove-Item (Join-Path $workspace 'BOOTSTRAP.md') -Force -ErrorAction SilentlyContinue`;
}
