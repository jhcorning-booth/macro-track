"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "@/components/store";
import {
  IconChevronDown,
  IconClose,
  IconFlash,
  IconImage,
  IconKeyboard,
  IconMic,
} from "@/components/icons";

/* Minimal shape of the Web Speech API — it isn't in lib.dom. */
interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  0: SpeechAlternative;
  isFinal: boolean;
  length: number;
}
interface SpeechResultList {
  length: number;
  [i: number]: SpeechResult;
}
interface SpeechEvent {
  resultIndex: number;
  results: SpeechResultList;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
type SpeechCtor = new () => SpeechRecognitionLike;

function speechCtor(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Long edge cap for uploads — plenty for label OCR, a fraction of the bytes. */
const MAX_EDGE = 1600;
/** One image is one food item (PRD §9); more than this in a batch is almost
 *  certainly a mis-tap, and a serverless request body has hard limits. */
const MAX_IMAGES = 6;

export default function AddScreen() {
  const { setScreen, analyze } = useApp();

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);

  const [camState, setCamState] = useState<"idle" | "live" | "denied" | "unsupported">("idle");
  const [torchOn, setTorchOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [note, setNote] = useState("");
  const [transcript, setTranscript] = useState("");
  const [micOn, setMicOn] = useState(false);
  const [yesterday, setYesterday] = useState(false);
  const [busy, setBusy] = useState(false);

  /* ------------------------------------------------------------ camera */

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCamState("unsupported");
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities?.() as { torch?: boolean } | undefined;
        setTorchAvailable(Boolean(caps?.torch));
        setCamState("live");
      } catch {
        if (!cancelled) setCamState("denied");
      }
    }

    void start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  }, [torchOn]);

  /* --------------------------------------------------------------- mic */

  useEffect(() => {
    return () => {
      recogRef.current?.stop();
      recogRef.current = null;
    };
  }, []);

  const toggleMic = useCallback(() => {
    if (micOn) {
      recogRef.current?.stop();
      setMicOn(false);
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) {
      // No on-device recognition (Firefox, some Android browsers). The typed
      // note carries the same information, so just focus it.
      setTranscript("");
      return;
    }
    const r = new Ctor();
    r.lang = "en-US";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      setTranscript(text.trim());
    };
    r.onerror = () => setMicOn(false);
    r.onend = () => setMicOn(false);
    recogRef.current = r;
    try {
      r.start();
      setMicOn(true);
    } catch {
      setMicOn(false);
    }
  }, [micOn]);

  /* ----------------------------------------------------------- capture */

  /** Re-encodes any image source down to MAX_EDGE. Applied to library picks
   *  as well as camera frames — a 12 MP photo straight off the roll is ~4 MB
   *  and three of them exceed a serverless request-body limit, which fails the
   *  upload before any evidence is stored. */
  const downscale = useCallback(
    async (
      source: HTMLVideoElement | HTMLImageElement,
      name: string,
    ): Promise<File | null> => {
      const w = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
      const h = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
      if (!w || !h) return null;
      const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, "image/jpeg", 0.85),
      );
      if (!blob) return null;
      return new File([blob], name, { type: "image/jpeg" });
    },
    [],
  );

  const shrinkPicked = useCallback(
    async (files: File[]): Promise<File[]> => {
      const out: File[] = [];
      for (const file of files.slice(0, MAX_IMAGES)) {
        const url = URL.createObjectURL(file);
        try {
          const img = await new Promise<HTMLImageElement | null>((res) => {
            const el = new Image();
            el.onload = () => res(el);
            el.onerror = () => res(null);
            el.src = url;
          });
          const shrunk = img ? await downscale(img, file.name.replace(/\.\w+$/, "") + ".jpg") : null;
          // If decoding fails (HEIC on a browser without support), send the
          // original rather than dropping the user's photo.
          out.push(shrunk ?? file);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      return out;
    },
    [downscale],
  );

  const submit = useCallback(
    async (files: File[]) => {
      if (busy) return;
      setBusy(true);
      recogRef.current?.stop();
      const payload = {
        files,
        note: note.trim(),
        transcript: transcript.trim(),
        dateOffset: (yesterday ? -1 : 0) as 0 | -1,
      };
      setNote("");
      setTranscript("");
      setMicOn(false);
      try {
        await analyze(payload);
      } finally {
        setBusy(false);
      }
    },
    [analyze, busy, note, transcript, yesterday],
  );

  const shoot = useCallback(async () => {
    if (camState !== "live" || !videoRef.current) {
      // No camera — fall back to the library picker rather than dead-ending.
      fileRef.current?.click();
      return;
    }
    const file = await downscale(videoRef.current, `capture-${Date.now()}.jpg`);
    if (file) await submit([file]);
  }, [camState, downscale, submit]);

  const canSubmitText = note.trim().length > 0 || transcript.trim().length > 0;

  return (
    <div className="flex h-full flex-col bg-camera">
      {/* ----------------------------------------------------- top bar */}
      <div className="flex items-center justify-between px-[18px] py-2.5">
        <button
          type="button"
          onClick={() => setScreen("today")}
          aria-label="Close camera"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-white/[0.12] text-white/95"
        >
          <IconClose size={17} />
        </button>

        <button
          type="button"
          onClick={() => setYesterday((v) => !v)}
          className="flex items-center gap-1 rounded-full border border-white/20 bg-white/10 px-3.5 py-[7px] font-mono text-[11px] text-white/95"
        >
          {yesterday ? "Yesterday" : "Today"}
          <IconChevronDown size={12} />
        </button>

        <button
          type="button"
          onClick={() => void toggleTorch()}
          disabled={!torchAvailable}
          aria-label="Toggle flash"
          aria-pressed={torchOn}
          className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-white/[0.12] disabled:opacity-35"
          style={{ color: torchOn ? "var(--color-accent)" : "rgba(255,255,255,.95)" }}
        >
          <IconFlash size={16} />
        </button>
      </div>

      {/* -------------------------------------------------- viewfinder */}
      <div
        className="relative mx-[18px] flex-1 overflow-hidden rounded-[28px]"
        style={{
          background:
            "repeating-linear-gradient(135deg, oklch(0.28 0.02 60) 0 8px, oklch(0.24 0.015 60) 8px 16px)",
        }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="h-full w-full object-cover"
          style={{ opacity: camState === "live" ? 1 : 0 }}
        />

        {camState !== "live" && (
          <div className="absolute inset-0 flex items-center justify-center px-8 text-center">
            <span className="font-mono text-[11px] leading-[1.7] tracking-[0.1em] text-[oklch(0.72_0.01_70)]">
              {camState === "idle"
                ? "starting camera…"
                : camState === "denied"
                  ? "camera blocked — use Library below"
                  : "no camera here — use Library below"}
            </span>
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-[34px] inset-y-[120px] rounded-[20px] border-[1.5px] border-white/35" />
        <div className="pointer-events-none absolute inset-x-0 bottom-[18px] text-center text-[12px] text-white/80">
          Label, plate, or bottle — anything works
        </div>
      </div>

      {/* -------------------------------------------------- note + mic */}
      <div className="flex gap-2.5 px-[18px] pt-3.5 pb-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note (optional)"
          className="flex-1 rounded-[16px] border border-white/[0.16] bg-white/[0.08] px-3.5 py-3 text-[13px] text-white/95 outline-none placeholder:text-white/45"
        />
        <button
          type="button"
          onClick={toggleMic}
          aria-label={micOn ? "Stop recording" : "Start recording"}
          aria-pressed={micOn}
          className="flex w-[46px] flex-none items-center justify-center rounded-[16px] border border-white/[0.16] text-white/95"
          style={{ background: micOn ? "var(--color-accent)" : "rgba(255,255,255,.08)" }}
        >
          <IconMic size={18} />
        </button>
      </div>

      {micOn && (
        <div className="mx-[18px] mb-1.5 flex items-center gap-2 rounded-[14px] bg-white/[0.08] px-3.5 py-2.5 text-[12.5px] text-white/90">
          <span className="h-[7px] w-[7px] flex-none animate-[pulse_1.1s_infinite] rounded-full bg-[oklch(0.7_0.19_25)]" />
          <span className="truncate">
            {transcript || "listening…"}
          </span>
        </div>
      )}

      {/* ---------------------------------------------------- controls */}
      <div className="flex items-center justify-around px-[18px] pt-2 pb-[max(26px,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="flex flex-col items-center gap-1.5 text-[11px] text-white/85"
        >
          <span
            className="flex h-[42px] w-[42px] items-center justify-center rounded-[12px] text-white/90"
            style={{
              background:
                "repeating-linear-gradient(135deg, oklch(0.4 0.02 60) 0 4px, oklch(0.34 0.02 60) 4px 8px)",
            }}
          >
            <IconImage size={18} />
          </span>
          Library
        </button>

        <button
          type="button"
          onClick={() => void shoot()}
          disabled={busy}
          aria-label="Capture and log"
          className="h-[82px] w-[82px] rounded-full border-[5px] border-white/[0.28] transition-colors disabled:opacity-60"
          style={{ background: "var(--color-accent)" }}
        />

        <button
          type="button"
          onClick={() => void submit([])}
          disabled={!canSubmitText || busy}
          className="flex flex-col items-center gap-1.5 text-[11px] text-white/85 disabled:opacity-40"
        >
          <span className="flex h-[42px] w-[42px] items-center justify-center rounded-[12px] border border-white/20">
            <IconKeyboard size={18} />
          </span>
          Type only
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void shrinkPicked(files).then((shrunk) => submit(shrunk));
        }}
      />
    </div>
  );
}
