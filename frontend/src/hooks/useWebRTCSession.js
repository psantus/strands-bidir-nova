import { useState, useRef, useCallback, useEffect } from 'react';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { getAWSCredentials } from '../aws-credentials.js';

const region = import.meta.env.VITE_REGION || 'us-east-1';

/**
 * Manages a WebRTC session to the voice agent.
 *
 * Local mode: POST to /invocations via Vite proxy.
 * Deployed mode: Uses @aws-sdk/client-bedrock-agentcore with runtimeSessionId for session affinity.
 */
export function useWebRTCSession({ agentRuntimeArn } = {}) {
  const [status, setStatus] = useState('disconnected');
  const [transcripts, setTranscripts] = useState([]);
  const [hasVideo, setHasVideo] = useState(false);
  const pcRef = useRef(null);
  const sessionIdRef = useRef(null);
  const videoRef = useRef(null);

  // Invoke the agent (local or deployed)
  const invoke = useCallback(async (action, data = {}) => {
    const payload = { action, data };

    if (agentRuntimeArn) {
      const creds = await getAWSCredentials();
      const client = new BedrockAgentCoreClient({
        region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
      const resp = await client.send(new InvokeAgentRuntimeCommand({
        agentRuntimeArn,
        runtimeSessionId: sessionIdRef.current,
        contentType: 'application/json',
        accept: 'application/json',
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      }));
      return JSON.parse(new TextDecoder().decode(await resp.response.transformToByteArray()));
    }

    // Local mode
    const resp = await fetch('/invocations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return resp.json();
  }, [agentRuntimeArn]);

  const connect = useCallback(async () => {
    if (pcRef.current) return;
    setStatus('connecting');
    setTranscripts([]);
    sessionIdRef.current = crypto.randomUUID();

    try {
      // 1. Get ICE config
      const { iceServers } = await invoke('ice_config');

      // 2. Create peer connection
      const pc = new RTCPeerConnection({ iceServers: iceServers || [] });
      pcRef.current = pc;

      // 3. Queue ICE candidates until we have a pc_id
      const pendingCandidates = [];
      let canSend = false;

      pc.ontrack = (e) => {
        if (e.track.kind === 'video') {
          setHasVideo(true);
          if (videoRef.current) {
            videoRef.current.srcObject = e.streams[0];
          }
        } else if (e.track.kind === 'audio') {
          const audio = new Audio();
          audio.srcObject = e.streams[0];
          audio.play().catch(() => {});
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === 'connected' || state === 'completed') setStatus('connected');
        else if (state === 'failed' || state === 'closed') setStatus('disconnected');
      };

      pc.onicecandidate = async (e) => {
        if (!e.candidate) return;
        const c = {
          candidate: e.candidate.candidate,
          sdp_mid: e.candidate.sdpMid,
          sdp_mline_index: e.candidate.sdpMLineIndex,
        };
        if (canSend) {
          await invoke('ice_candidate', { pc_id: pc._pcId, candidates: [c] }).catch(() => {});
        } else {
          pendingCandidates.push(c);
        }
      };

      // 4. Capture mic
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      pc.addTransceiver(stream.getAudioTracks()[0], { direction: 'sendrecv' });

      // 5. Create and send offer
      const offer = await pc.createOffer({ offerToReceiveAudio: 1 });
      await pc.setLocalDescription(offer);

      const answer = await invoke('offer', { sdp: offer.sdp, type: offer.type });
      pc._pcId = answer.pc_id;
      await pc.setRemoteDescription(new RTCSessionDescription({ sdp: answer.sdp, type: answer.type }));

      // 6. Flush queued candidates
      canSend = true;
      for (const c of pendingCandidates) {
        await invoke('ice_candidate', { pc_id: pc._pcId, candidates: [c] }).catch(() => {});
      }

      setStatus('connected');
    } catch (err) {
      console.error('[WebRTC] Connection failed:', err);
      disconnect();
    }
  }, [invoke]);

  const disconnect = useCallback(async () => {
    if (pcRef.current) {
      const pcId = pcRef.current._pcId;
      pcRef.current.getSenders().forEach((s) => s.track?.stop());
      pcRef.current.close();
      pcRef.current = null;
      if (pcId) invoke('disconnect', { pc_id: pcId }).catch(() => {});
    }
    sessionIdRef.current = null;
    setStatus('disconnected');
    setHasVideo(false);
  }, [invoke]);

  useEffect(() => {
    return () => {
      if (pcRef.current) {
        pcRef.current.getSenders().forEach((s) => s.track?.stop());
        pcRef.current.close();
      }
    };
  }, []);

  return { status, transcripts, hasVideo, videoRef, connect, disconnect };
}
