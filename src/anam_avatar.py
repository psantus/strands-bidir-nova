"""Anam avatar session manager — audio passthrough mode."""

import asyncio
import logging

from anam import AnamClient, AnamEvent, ClientOptions
from anam.types import AgentAudioInputConfig, PersonaConfig

logger = logging.getLogger(__name__)


class AnamAvatar:
    """Manages an Anam speech-to-video session for a single WebRTC call."""

    def __init__(self, api_key, avatar_id):
        self._api_key = api_key
        self._avatar_id = avatar_id
        self._session = None
        self._agent_stream = None
        self._client = None

    async def start(self):
        persona_config = PersonaConfig(
            avatar_id=self._avatar_id,
            enable_audio_passthrough=True,
        )
        self._client = AnamClient(
            api_key=self._api_key,
            persona_config=persona_config,
            options=ClientOptions(),
        )

        session_ready = asyncio.Event()

        @self._client.on(AnamEvent.SESSION_READY)
        async def on_ready():
            session_ready.set()

        self._session = await self._client.connect_async()
        await self._session.__aenter__()

        try:
            await asyncio.wait_for(session_ready.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            logger.error("Anam session did not become ready in 30s")
            raise

        self._agent_stream = self._session.create_agent_audio_input_stream(
            AgentAudioInputConfig(encoding="pcm_s16le", sample_rate=24000, channels=1)
        )
        logger.info("Anam avatar session ready (avatar=%s)", self._avatar_id)

    async def send_audio(self, pcm_bytes):
        if self._agent_stream:
            await self._agent_stream.send_audio_chunk(pcm_bytes)

    async def end_turn(self):
        if self._agent_stream:
            try:
                await self._agent_stream.end_sequence()
            except Exception as e:
                logger.debug("Anam end_sequence: %s", e)

    def video_frames(self):
        return self._session.video_frames()

    async def stop(self):
        try:
            if self._session:
                await self._session.__aexit__(None, None, None)
        except Exception as e:
            logger.debug("Anam cleanup: %s", e)
        self._session = None
        self._agent_stream = None
