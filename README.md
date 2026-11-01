# OmniCast

**Decentralized Peer-to-Peer Live Broadcasting Protocol**

> Single-Encode · WebRTC DataChannels · Tree-Mesh Cascades · Zero CDN Media Delivery Egress

OmniCast is a browser-native live broadcasting platform that eliminates centralized video distribution egress costs. The broadcaster encodes video and audio **once** in the browser; chunks are cryptographically signed using Web Crypto ECDSA P-256 and distributed directly between viewer browsers over native WebRTC `RTCDataChannel` connections in a self-organizing 5-child tree-mesh topology. Viewers decode and play the media via MediaSource Extensions (MSE) while forwarding the exact same immutable binary chunks to downstream peers.

---

## ✨ Features

- **Zero Centralized Media Egress:** The central signaling server handles only lightweight JSON control messages (discovery, SDP/ICE exchange, topology coordination), carrying **zero live media bytes**.
- **Single-Encode Efficiency:** The origin captures (webcam or screen share) and encodes media once (~300ms timeslice). Relay peers forward raw binary chunks without re-encoding, preserving pristine visual quality with minimal CPU overhead.
- **Cryptographic Chunk Provenance:** Origin signs each segment using Web Crypto ECDSA P-256 over a canonical SHA-256 envelope. Viewers verify authenticity before playing or re-forwarding, dropping any tampered or spoofed packets.
- **Self-Healing Tree-Mesh Topology:** The topology coordinator enforces a 5-child fanout limit with breadth-first tier placement and sub-400ms automatic parent failover backed by standby connections and an in-memory buffer cushion.
- **Dynamic Source Switching:** Live transitions between Camera and Screen Share (with microphone audio mixing) while actively on the air, using MSE parser resets (`sourceBuffer.abort()`) and timestamp offset bridging.
- **Late-Join GOP Synchronization:** Keyframe-preserving ring buffer retention guarantees that late-joining viewers receive the container header and active keyframe immediately, eliminating playback freezes.
- **Mobile-Safe Tiering:** Mobile and cellular devices are classified as receive-only leaves (`relayEligible: false`), protecting battery life and mobile data limits.
- **100% Browser Native:** Runs completely in standard modern desktop and mobile browsers without requiring OBS plugins or client software installations.

---

## 🏗️ Architecture

```
                      ┌────────────────────────────────────────┐
                      │ Central Signaling & Topology (Node.js) │
                      │       ws://host:10000/signaling        │
                      └──────────────────┬─────────────────────┘
                                         │ (Control & SDP/ICE Only - 0 Media Bytes)
            ┌────────────────────────────┼────────────────────────────┐
            ▼                            ▼                            ▼
┌───────────────────────┐    ┌───────────────────────┐    ┌───────────────────────┐
│  Broadcaster (Tier 0) │    │  Viewer B (Tier 1)    │    │  Viewer C (Tier 1)    │
│  Single Encode + Sign │    │  MSE Play + Relay     │    │  MSE Play (Mobile)    │
└───────────┬───────────┘    └───────────┬───────────┘    └───────────────────────┘
            │                            │
            │ Direct WebRTC DataChannel  │ Direct WebRTC DataChannel
            ▼                            ▼
┌───────────────────────┐    ┌───────────────────────┐
│  Viewer A (Tier 1)    │    │  Viewer D (Tier 2)    │
│  MSE Play + Relay     │    │  Cascaded Playback    │
└───────────────────────┘    └───────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js:** v18.0.0 or higher (tested on Node v20 & v24)
- **npm:** v9.0.0 or higher
- **Browser:** Google Chrome, Microsoft Edge, Mozilla Firefox, or Apple Safari

### Installation

```bash
# Clone the repository
git clone https://github.com/singh-105/omnicast.git
cd omnicast

# Install dependencies
npm install
```

### Running Locally

To run both the frontend dev server (Vite on port 5173) and the signaling server (Node.js on port 10000) concurrently:

```bash
npm run dev
```

- **Broadcaster Studio:** Open [http://localhost:5173/studio](http://localhost:5173/studio) and click **"Start Broadcast"**.
- **Explore Live Streams:** Open [http://localhost:5173/explore](http://localhost:5173/explore) to view and search active broadcasts.
- **Watch Stream:** Navigate to [http://localhost:5173/watch/:broadcastId](http://localhost:5173/watch/:broadcastId) on multiple tabs or devices.

---

## 🧪 Testing

```bash
# Run unit and integration tests
npm test

# Run end-to-end browser automation suites (Playwright)
npm run test:e2e

# Build for production
npm run build
```

---

## 🛠️ Tech Stack

- **Frontend:** React 18, Vite 5, Tailwind CSS, Lucide Icons
- **Media Engine:** MediaStream (`getUserMedia`, `getDisplayMedia`), MediaRecorder (WebM / VP8 / Opus), MediaSource Extensions (MSE)
- **Networking:** WebRTC (`RTCPeerConnection`, `RTCDataChannel`), STUN/TURN traversal
- **Signaling:** Node.js, `ws` (WebSocketServer)
- **Cryptography:** Web Crypto API (`crypto.subtle`, ECDSA P-256, SHA-256)

---

## 📄 License

MIT License. Developed for NOVEX Hackathon 2026.
