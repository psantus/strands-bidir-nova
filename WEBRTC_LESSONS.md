# WebRTC on AgentCore Runtime — Lessons Learned

Key gotchas and solutions from deploying a WebRTC voice agent on Bedrock AgentCore Runtime with KVS TURN relay.

## 1. VPC Availability Zone Compatibility

AgentCore Runtime only supports specific AZs. In us-east-1, only `use1-az4` (us-east-1a), `use1-az1` (us-east-1c), and `use1-az2` (us-east-1d) are supported. Using an unsupported AZ (e.g. us-east-1b / use1-az6) causes `UPDATE_FAILED` with no obvious error unless you inspect `failureReason` in the API response.

**Fix:** Hardcode supported AZs in the VPC module rather than using `data.aws_availability_zones`.

## 2. Session Affinity with `runtimeSessionId`

AgentCore's HTTP `/invocations` endpoint does NOT guarantee that consecutive requests go to the same container instance. WebRTC signaling requires multiple requests (ice_config → offer → ice_candidate) that share in-memory state (the `RTCPeerConnection` object).

Raw SigV4-signed HTTP POST requests — even with `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` as a query parameter — do NOT provide session affinity.

**Fix:** Use `@aws-sdk/client-bedrock-agentcore` with `InvokeAgentRuntimeCommand` and the `runtimeSessionId` parameter. This is the only reliable way to ensure all requests for a WebRTC session reach the same instance.

```javascript
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';

const resp = await client.send(new InvokeAgentRuntimeCommand({
  agentRuntimeArn,
  runtimeSessionId: sessionId,  // same ID for all requests in a session
  contentType: 'application/json',
  accept: 'application/json',
  payload: new TextEncoder().encode(JSON.stringify({ action, data })),
}));
```

## 3. SDP Candidate Filtering (Performance)

aiortc generates host candidates with VPC-internal IPs (e.g. `169.254.0.2`) that browsers can never reach. While ICE would eventually fall back to relay candidates, including unreachable host candidates causes the browser to waste time on failed connectivity checks before trying relay.

**Fix:** Strip non-relay candidates from the SDP answer to speed up ICE connection:

```python
if IS_CONTAINER:
    sdp = "\r\n".join(
        line for line in sdp.split("\r\n")
        if not line.startswith("a=candidate:") or "typ relay" in line
    )
```

## 4. Lazy KVS Initialization

`kvs.init()` calls the KVS API to find/create a signaling channel. If this runs at module import time (`if IS_CONTAINER: kvs.init()`), the container crashes on startup if there's any delay in IAM credential propagation or network connectivity.

**Fix:** Initialize KVS lazily on the first request, not at import time:

```python
_kvs_initialized = False

def _ensure_kvs():
    global _kvs_initialized
    if not _kvs_initialized and IS_CONTAINER:
        kvs.init()
        _kvs_initialized = True
```

## 5. Docker Image Tag Must Change for Runtime Updates

AgentCore Runtime won't re-pull a Docker image if the `containerUri` tag is the same, even if the image contents changed. A content-based hash that only covers `.py` files will miss Dockerfile or requirements.txt changes.

**Fix:** Hash ALL files in the source directory:

```hcl
locals {
  all_src_files = [for f in fileset(var.agent_source_dir, "**") : f
    if !can(regex("__pycache__|\\.pyc$|\\.pyo$|\\.dockerignore$", f))]
  src_hash  = sha1(join("", [for f in sort(local.all_src_files) : filesha1("${var.agent_source_dir}/${f}")]))
  image_tag = "src-${local.src_hash}"
}
```

## 6. TURN-Only Mode on Agent Side (Performance)

Without this, aiortc tries host candidates first (VPC-internal IPs that can never work), waits for timeouts, then falls back to relay. Forcing TURN-only skips straight to relay candidates and speeds up ICE connection.

**Fix:** Configure aiortc to only use TURN relay candidates:

```python
ice_servers = kvs.get_rtc_ice_servers(region, client_id="server", turn_only=True)
```

## Architecture Summary

```
Browser                          AWS Cloud
┌──────────┐    WebRTC/UDP     ┌─────────────────────────────────┐
│ React app│◄──────────────────►│ KVS TURN Relay                 │
│ (mic +   │    (via TURN)     │                                 │
│  speaker)│                   │         ▲                       │
└──────────┘                   │         │ UDP                   │
                               │         ▼                       │
                               │ ┌─────────────────────────┐    │
                               │ │ AgentCore Runtime (VPC)  │    │
                               │ │                          │    │
                               │ │  aiortc ◄─► BidiAgent    │    │
                               │ │              │           │    │
                               │ │              ▼           │    │
                               │ │        Nova Sonic v2     │    │
                               │ │     (Bedrock HTTP/2)     │    │
                               │ └─────────────────────────┘    │
                               │         NAT Gateway             │
                               └─────────────────────────────────┘
```
