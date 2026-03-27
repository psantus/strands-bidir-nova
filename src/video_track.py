"""WebRTC video output track fed by Anam avatar frames."""

import asyncio
import fractions
import time

import av
from aiortc.mediastreams import MediaStreamTrack

FPS = 25
FRAME_DURATION = 1 / FPS


class VideoOutputTrack(MediaStreamTrack):
    """Streams video frames from Anam to the browser via WebRTC."""

    kind = "video"

    def __init__(self, width=720, height=480):
        super().__init__()
        self._queue = asyncio.Queue(maxsize=50)
        self._start_time = None
        self._frame_count = 0
        self._last_frame = self._black_frame(width, height)

    @staticmethod
    def _black_frame(width, height):
        frame = av.VideoFrame(width=width, height=height, format="rgb24")
        for p in frame.planes:
            p.update(bytes(p.buffer_size))
        return frame

    def push(self, frame):
        try:
            self._queue.put_nowait(frame)
        except asyncio.QueueFull:
            pass

    async def recv(self):
        if self._start_time is None:
            self._start_time = time.time()

        delay = self._start_time + self._frame_count * FRAME_DURATION - time.time()
        if delay > 0:
            await asyncio.sleep(delay)

        try:
            frame = self._queue.get_nowait()
            self._last_frame = frame
        except asyncio.QueueEmpty:
            frame = self._last_frame

        frame.pts = self._frame_count
        frame.time_base = fractions.Fraction(1, FPS)
        self._frame_count += 1
        return frame
