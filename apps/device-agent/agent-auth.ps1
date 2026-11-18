# Shared by the farm scripts. Dot-source it:  . "$PSScriptRoot\agent-auth.ps1"
#
# Defines $AgentHeaders with the x-agent-token header for calls to device-agent.
# The token comes from the DEVICE_AGENT_TOKEN environment variable or, if that is
# not set, from the .env file next to this script (the same file device-agent reads).
# With no token configured $AgentHeaders is empty and the calls work as before.
# Pass it ONLY to device-agent URLs, never to external services.

$AgentToken = $env:DEVICE_AGENT_TOKEN
if (-not $AgentToken) {
    $agentEnvFile = Join-Path $PSScriptRoot '.env'
    if (Test-Path $agentEnvFile) {
        foreach ($agentEnvLine in Get-Content $agentEnvFile) {
            if ($agentEnvLine -match '^\s*DEVICE_AGENT_TOKEN\s*=\s*(.*)$') {
                $AgentToken = $matches[1].Trim().Trim('"').Trim("'")
            }
        }
    }
}

$AgentHeaders = @{}
if ($AgentToken) { $AgentHeaders['x-agent-token'] = $AgentToken }
