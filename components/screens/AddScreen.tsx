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

/** How long the frame is held after the shutter before the analysis fires.
 *
 *  PRD §17 makes "upload optional text or voice" step 2, between the photo and
 *  the analysis, but the shutter used to run all of it in a single tick — so
 *  the one input that can override the model's portion estimate had to be
 *  typed BEFORE the food was even framed. This is that step: a beat to think
 *  "wait, I only ate half".
 *
 *  It costs nothing to a user who ignores it — the window advances itself, so
 *  the happy path is still zero taps beyond the shutter — and tapping the
 *  button again logs immediately, which is what a double-tap of the old
 *  shutter now does. Touching the note or speaking cancels the countdown
 *  outright: once someone is clearly mid-thought, no deadline should apply. */
const GRACE_MS = 2500;

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
  /** A captured-but-not-yet-sent frame. Non-null means the grace window is
   *  open and the viewfinder is showing a still rather than the live feed. */
  const [held, setHeld] = useState<{ files: File[]; frame: string } | null>(null);
  /** The user has started saying something. Cancels the auto-advance for good
   *  — a countdown running under someone's thumb is the bug being fixed. */
  const [engaged, setEngaged] = useState(false);

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
      // Speech counts as engagement — PRD §14 wants the transcript final at
      // analyze time, not at shutter time, so the window must not close out
      // from under someone mid-sentence.
      if (text.trim()) setEngaged(true);
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
      setMicOn(false);
      try {
        await analyze(payload);
        // Cleared only once the words are safely in the request. Clearing
        // before the await meant a capture that failed early took the user's
        // note down with it, leaving nothing to retry with.
        setNote("");
        setTranscript("");
      } finally {
        setBusy(false);
      }
    },
    [analyze, busy, note, transcript, yesterday],
  );

  /* The held frame is mirrored in a ref, and every transition below reads and
   * writes that ref rather than a setState updater.
   *
   * This is not defensive style, it is required. Updater callbacks must be
   * pure: React re-invokes them during render, twice under StrictMode. An
   * earlier version revoked the blob URL and called submit() from inside one,
   * which fired the analysis mid-render — the window opened and committed in
   * the same frame, and React logged "cannot update a component while
   * rendering a different component" as the request went out. */
  const heldRef = useRef<{ files: File[]; frame: string } | null>(null);

  /** Freezes a capture and opens the grace window. Used by both the shutter
   *  and the library picker — a photo chosen off the roll needs describing at
   *  least as much as one just taken. */
  const hold = useCallback((files: File[]) => {
    if (!files.length) return;
    if (heldRef.current) URL.revokeObjectURL(heldRef.current.frame);
    const next = { files, frame: URL.createObjectURL(files[0]) };
    heldRef.current = next;
    setHeld(next);
    setEngaged(false);
  }, []);

  /** Releases the held frame, returning what was held. Null on the second
   *  call, which is what makes commit and retake idempotent: the auto-advance
   *  firing at the same moment as a tap cannot submit the same photo twice. */
  const release = useCallback(() => {
    const cur = heldRef.current;
    if (!cur) return null;
    heldRef.current = null;
    setHeld(null);
    setEngaged(false);
    URL.revokeObjectURL(cur.frame);
    return cur;
  }, []);

  const commit = useCallback(() => {
    const cur = release();
    if (cur) void submit(cur.files);
  }, [release, submit]);

  /** Drops the capture and goes back to the live feed. */
  const retake = useCallback(() => {
    if (release()) void videoRef.current?.play().catch(() => {});
  }, [release]);

  const shoot = useCallback(async () => {
    if (camState !== "live" || !videoRef.current) {
      // No camera — fall back to the library picker rather than dead-ending.
      fileRef.current?.click();
      return;
    }
    // Pausing paints the frame the user just framed, in the same tick as the
    // tap. The tracks stay live so Retake is instant and costs no permission
    // prompt; they are stopped on unmount as before.
    videoRef.current.pause();
    const file = await downscale(videoRef.current, `capture-${Date.now()}.jpg`);
    if (file) hold([file]);
    else void videoRef.current.play().catch(() => {});
  }, [camState, downscale, hold]);

  /* ------------------------------------------------------ grace window */

  // The auto-advance. Deliberately keyed only on `held` and `engaged`: a timer
  // that restarted on every keystroke would either never fire or fire mid-word
  // depending on typing speed. Once engaged it is gone until the user commits.
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  useEffect(() => {
    if (!held || engaged) return;
    const t = setTimeout(() => commitRef.current(), GRACE_MS);
    return () => clearTimeout(t);
  }, [held, engaged]);

  // A held frame that never got sent (the user left the screen) would leak its
  // blob URL. Reads the ref directly — a cleanup function must not setState.
  useEffect(() => {
    return () => {
      if (heldRef.current) {
        URL.revokeObjectURL(heldRef.current.frame);
        heldRef.current = null;
      }
    };
  }, []);

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

        {held && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={held.frame}
            alt="The photo you just took"
            className="absolute inset-0 h-full w-full animate-pop-fast object-cover"
          />
        )}

        {!held && camState !== "live" && (
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

        {!held && (
          <div className="pointer-events-none absolute inset-x-[34px] inset-y-[120px] rounded-[20px] border-[1.5px] border-white/35" />
        )}
        <div className="pointer-events-none absolute inset-x-0 bottom-[18px] px-6 text-center text-[12px] text-white/80 text-balance">
          {held
            ? engaged
              ? "Take your time — tap Log it when you're done"
              : "Logging in a moment — add a note if you like"
            : "Label, plate, or bottle — anything works"}
        </div>
      </div>

      {/* -------------------------------------------------- note + mic */}
      <div className="flex gap-2.5 px-[18px] pt-3.5 pb-2">
        <input
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setEngaged(true);
          }}
          onFocus={() => setEngaged(true)}
          // Without this the on-screen keyboard has no dismiss affordance at
          // all: the field sits in a fixed, unscrollable shell, so Enter was
          // the only way out and it did nothing.
          enterKeyHint="done"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          autoCapitalize="sentences"
          autoCorrect="on"
          // "Optional" undersold it — this is the one input that can override
          // the model's portion estimate, so it says what it is for.
          placeholder={held ? "Half of it? Two scoops?" : "Add a note — e.g. half of it"}
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
        {held ? (
          <button
            type="button"
            onClick={retake}
            className="flex flex-col items-center gap-1.5 text-[11px] text-white/85"
          >
            <span className="flex h-[42px] w-[42px] items-center justify-center rounded-[12px] border border-white/20 text-white/90">
              <IconClose size={18} />
            </span>
            Retake
          </button>
        ) : (
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
        )}

        {/* Same button, same place, both states — so the old muscle memory of
            double-tapping the shutter still logs instantly. */}
        <button
          type="button"
          onClick={() => (held ? commit() : void shoot())}
          disabled={busy}
          aria-label={held ? "Log it now" : "Capture and log"}
          className="relative flex h-[82px] w-[82px] items-center justify-center rounded-full border-[5px] border-white/[0.28] text-[13px] font-bold text-white transition-colors disabled:opacity-60"
          style={{ background: "var(--color-accent)" }}
        >
          {held && "Log it"}
          {held && !engaged && (
            <span
              key={held.frame}
              aria-hidden
              className="pointer-events-none absolute inset-[-5px] rounded-full border-[5px] border-white/70"
              style={{ animation: `grace ${GRACE_MS}ms linear forwards` }}
            />
          )}
        </button>

        {held ? (
          // Placeholder keeps the shutter centred while the window is open.
          <span aria-hidden className="h-[42px] w-[42px]" />
        ) : (
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
        )}
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
          if (files.length) void shrinkPicked(files).then((shrunk) => hold(shrunk));
        }}
      />
    </div>
  );
}
