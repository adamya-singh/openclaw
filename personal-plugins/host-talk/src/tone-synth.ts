// Feedback tones are synthesized PCM16 so the plugin ships no binary assets.

export const TONE_SAMPLE_RATE_HZ = 24_000;

export type ToneName = "wake" | "end" | "error";

const TONE_NOTES: Record<ToneName, ReadonlyArray<{ hz: number; ms: number }>> = {
  wake: [
    { hz: 660, ms: 90 },
    { hz: 880, ms: 130 },
  ],
  end: [
    { hz: 880, ms: 90 },
    { hz: 660, ms: 130 },
  ],
  error: [
    { hz: 330, ms: 160 },
    { hz: 247, ms: 260 },
  ],
};

export function synthesizeTone(name: ToneName): Buffer {
  const chunks = TONE_NOTES[name].map(({ hz, ms }) => {
    const samples = Math.floor((TONE_SAMPLE_RATE_HZ * ms) / 1000);
    const fade = Math.floor(TONE_SAMPLE_RATE_HZ * 0.008);
    const out = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i += 1) {
      const envelope = Math.min(1, i / fade, (samples - i) / fade);
      const value = Math.sin((2 * Math.PI * hz * i) / TONE_SAMPLE_RATE_HZ) * 5000 * envelope;
      out.writeInt16LE(Math.round(value), i * 2);
    }
    return out;
  });
  return Buffer.concat(chunks);
}
