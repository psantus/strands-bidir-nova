# Family Recipe Assistant - Voice Edition

A real-time voice agent that uses **Strands BidiAgent** and **Amazon Nova Sonic 2** for bidirectional audio streaming with tool use. Search your family recipes, look up nutrition, set cooking timers, and convert units - all by voice.

Built as a companion demo for the blog post: [Bi-directional Voice-Controlled Recipe Assistant with Nova Sonic v2](https://darryl-ruggles.cloud/bi-directional-voice-controlled-recipe-assistant-with-nova-sonic-2/)

## What It Does

Talk to a kitchen assistant that can:

- **Search recipes** by voice ("find me a quick pasta recipe") via Bedrock Knowledge Base
- **Set cooking timers** ("set a timer for 12 minutes for the pasta")
- **Look up nutrition** ("how many calories in a cup of rice?") via USDA FoodData Central
- **Convert units** ("convert 2 cups to milliliters" or "what is 350 fahrenheit in celsius?")
- **Handle interruptions** - change your mind mid-sentence and the agent adapts

## Architecture

**Transport:** WebRTC with KVS TURN relay (deployed) or direct P2P (local dev).

The browser captures mic audio via the native WebRTC API and streams it to the agent over a peer connection. The agent runs Strands BidiAgent with Nova Sonic v2 and streams spoken responses back over the same WebRTC connection.

**Deployed mode:** AgentCore Runtime in a VPC with NAT gateway for KVS TURN egress. Browser connects via HTTP signaling to `/invocations` (SDP offer/answer + ICE candidates), then audio flows over WebRTC/UDP through the TURN relay.

**Local mode:** Agent runs on your machine. No VPC, no TURN — WebRTC connects peer-to-peer on localhost. Signaling goes through the Vite dev proxy to the local FastAPI server.

## Prerequisites

- **Python 3.13+** (3.12 minimum for Nova Sonic)
- **Node.js 18+** for the Vite frontend dev server
- **AWS account** with Bedrock model access enabled for Nova Sonic v2
- **System libraries** for aiortc/av:
  - macOS: `brew install portaudio libav opus libvpx pkg-config`
  - Ubuntu/Debian: `sudo apt install portaudio19-dev libavdevice-dev libopus-dev libvpx-dev pkg-config`
- **uv** for Python dependency management: `curl -LsSf https://astral.sh/uv/install.sh | sh`

## Setup

```bash
# Clone the repo
git clone <repo-url>
cd strands-bidir-nova

# Install dependencies
uv sync
make install-frontend

# Configure AWS (must have Nova Sonic v2 access in your region)
export AWS_REGION=us-east-1
```

## Running Locally

```bash
# Terminal 1: Start the server (WebRTC signaling + BidiAgent)
make serve

# Terminal 2: Start the Vite dev server
make serve-frontend
```

Open [http://localhost:5173](http://localhost:5173), click the microphone button, and start talking.

In local mode, WebRTC connects peer-to-peer (no TURN needed). The Vite dev server proxies `/invocations` to the local FastAPI server.

## Deploying to AWS

The deployed architecture uses AgentCore Runtime in a VPC, KVS TURN for WebRTC media relay, CloudFront + S3 for the frontend, and Cognito for authentication.

**Additional prerequisites:**

- **Terraform** for infrastructure provisioning
- **Docker** for building the container image

**Steps:**

```bash
# 1. Create terraform.tfvars from the example template
cp infrastructure/terraform.tfvars.example infrastructure/terraform.tfvars
# Edit terraform.tfvars: set knowledge_base_id, cognito_users

# 2. Provision everything (VPC, Cognito, CDN, AgentCore, frontend deploy)
make plan
make apply
```

A single `terraform apply` handles:
- VPC with private subnets + NAT gateway
- ECR repository + Docker image build/push
- AgentCore runtime creation (VPC mode)
- KVS signaling channel (created by agent on first run)
- Cognito user pool + users
- Frontend build + S3 deploy + CloudFront invalidation

## Project Structure

```
strands-bidir-nova/
├── src/
│   ├── server.py             # FastAPI server (WebRTC signaling + BidiAgent)
│   ├── config.py             # Model config, system prompt
│   ├── kvs.py                # KVS signaling channel + TURN credentials
│   ├── audio_track.py        # WebRTC output track (av.AudioFifo)
│   ├── webrtc_io.py          # BidiInput/BidiOutput adapters for aiortc
│   ├── Dockerfile            # ARM64 container for AgentCore
│   ├── requirements.txt      # Container pip dependencies
│   └── tools/
│       ├── recipe_search.py    # Bedrock KB retrieval
│       ├── set_timer.py        # Async cooking timer
│       ├── nutrition_lookup.py # USDA FoodData Central
│       └── unit_converter.py   # Measurement conversions
├── frontend/                 # Browser voice UI (React 19 + Vite)
│   ├── src/
│   │   ├── App.jsx              # Root component (auth wrapper)
│   │   ├── auth.js              # Cognito sign-in/sign-up/sign-out
│   │   ├── aws-credentials.js   # Exchange JWT for temp AWS credentials
│   │   ├── contexts/
│   │   │   └── AuthContext.jsx    # Cognito auth state provider
│   │   ├── components/
│   │   │   ├── VoiceChat.jsx      # Mic button, status, transcript display
│   │   │   └── AuthScreen.jsx     # Sign-in form (deployed mode)
│   │   └── hooks/
│   │       └── useWebRTCSession.js  # WebRTC lifecycle (ICE, SDP, peer connection)
│   ├── .env.example          # Template for deployed mode env vars
│   ├── package.json
│   ├── vite.config.js
│   └── index.html
├── infrastructure/           # Terraform modules
│   └── modules/
│       ├── vpc/              # VPC, subnets, NAT gateway, security group
│       ├── agent/            # ECR, IAM, Docker build, AgentCore runtime
│       ├── bedrock/          # IAM role for local dev (Bedrock access)
│       ├── storage/          # S3 frontend bucket
│       ├── auth/             # Cognito user pool + identity pool
│       ├── cdn/              # CloudFront distribution (S3 origin)
│       └── frontend/         # Frontend build + S3 deploy
├── pyproject.toml            # uv project config
└── Makefile                  # Common commands
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| No audio from agent | Check browser console for WebRTC ICE connection state. In local mode, ensure the server is running on port 8080 |
| ICE connection failed (deployed) | Verify VPC has NAT gateway with internet egress. Check agent role has KVS permissions |
| Nova Sonic silently ignores audio | IAM model ID gotcha: foundation model ARN is `amazon.nova-2-sonic-v1:0`, not `amazon.nova-sonic-v2` |
| Session cuts off at 8 min | Nova Sonic v2 limit - restart the session |
| Browser mic permission denied | Click the lock icon in the URL bar and allow microphone access |
| Docker build fails | Ensure Docker Desktop is running. ARM64 build requires Docker buildx |

## Related

- [Serverless Recipe Assistant](https://darryl-ruggles.cloud/serverless-recipe-assistant-with-agentcore-and-strands/) - The text-based version
- [Strands BidiAgent docs](https://strandsagents.com/latest/documentation/docs/user-guide/concepts/bidirectional-streaming/quickstart/)
- [Nova Sonic v2 docs](https://docs.aws.amazon.com/nova/latest/nova2-userguide/sonic-integrations.html)
- [WebRTC on AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-webrtc.html)
- [AWS WebRTC sample](https://github.com/awslabs/amazon-bedrock-agentcore-samples/tree/main/01-tutorials/01-AgentCore-runtime/06-bi-directional-streaming-webrtc)
