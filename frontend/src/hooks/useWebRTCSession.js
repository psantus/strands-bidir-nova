import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Manages a WebRTC session to the voice agent server.
 *
 * Handles ICE config fetch, SDP offer/answer, ICE candidate exchange,
 * and mic audio streaming via RTCPeerConnection.
 *
 * In local mode, POSTs to the Vite proxy at /invocations.
 * In deployed mode, uses the provided invokeUrl with SigV4 signing.
 */
export function useWebRTCSession({ invokeUrl, signRequest } = {}) {
  const [status, setStatus] = useState('disconnected');
  const [transcripts, setTranscripts] = useState([]);
  const pcRef = useRef(null);
  const pcIdRef = useRef(null);
  const remoteAudioRef = useRef(null);

  // Resolve the base URL for signaling
  const getBaseUrl = useCallback(() => {
    if (invokeUrl) return invokeUrl;
    return `${window.location.protocol}//${window.location.host}`;
  }, [invokeUrl]);

  // POST to /invocations (local or deployed)
  const invoke = useCallback(async (body) => {
    const url = invokeUrl
      ? invokeUrl
      : `${window.location.protocol}//${window.location.host}/invocations`;

    const headers = { 'Content-Type': 'application/json' };

    // If signRequest is provided (deployed mode), use it for SigV4
    if (signRequest) {
      const signed = await signRequest(url, body);
      const resp = await fetch(signed.url, {
        method: 'POST',
        headers: { ...headers, ...signed.headers },
        body: JSON.stringify(body),
      });
      return resp.json();
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return resp.json();
  }, [invokeUrl, signRequest]);

  const connect = useCallback(async () => {
    if (pcRef.current) return;

    setStatus('connecting');
    setTranscripts([]);

    try {
      // 1. Get ICE server config
      const iceConfig = await invoke({ action: 'ice_config' });

      // 2. Create peer connection
      const pc = new RTCPeerConnection({
        iceServers: iceConfig.iceServers || [],
      });
      pcRef.current = pc;

      // 3. Handle remote audio track (agent's voice)
      pc.ontrack = (event) => {
        if (event.track.kind === 'audio') {
          const audio = new Audio();
          audio.srcObject = new MediaStream([event.track]);
          audio.play().catch(() => {});
          remoteAudioRef.current = audio;
        }
      };

      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === 'connected' || state === 'completed') {
          setStatus('connected');
        } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          setStatus('disconnected');
        }
      };

      // 4. Capture mic audio and add track
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));

      // 5. Create and send offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const answer = await invoke({
        action: 'offer',
        data: { sdp: offer.sdp, type: offer.type },
      });

      pcIdRef.current = answer.pc_id;
      await pc.setRemoteDescription(new RTCSessionDescription({
        sdp: answer.sdp,
        type: answer.type,
      }));

      // 6. Trickle ICE candidates
      pc.onicecandidate = async (event) => {
        if (event.candidate) {
          await invoke({
            action: 'ice_candidate',
            data: {
              pc_id: pcIdRef.current,
              candidates: [{
                candidate: event.candidate.candidate,
                sdp_mid: event.candidate.sdpMid,
                sdp_mline_index: event.candidate.sdpMLineIndex,
              }],
            },
          }).catch(() => {});
        }
      };

      setStatus('connected');
    } catch (err) {
      console.error('[WebRTC] Connection failed:', err);
      disconnect();
    }
  }, [invoke]);

  const disconnect = useCallback(async () => {
    if (pcIdRef.current) {
      await invoke({ action: 'disconnect', data: { pc_id: pcIdRef.current } }).catch(() => {});
    }

    if (pcRef.current) {
      pcRef.current.getSenders().forEach((sender) => {
        if (sender.track) sender.track.stop();
      });
      pcRef.current.close();
      pcRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
      remoteAudioRef.current = null;
    }

    pcIdRef.current = null;
    setStatus('disconnected');
  }, [invoke]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pcRef.current) {
        pcRef.current.getSenders().forEach((s) => s.track?.stop());
        pcRef.current.close();
      }
    };
  }, []);

  return { status, transcripts, connect, disconnect };
}
