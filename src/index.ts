import {
  definePluginContext,
  subscribeEvent,
} from "@ciderapp/pluginkit";

// Persist to our own localStorage key instead of Cider's saveConfig().
// saveConfig() writes Cider's reactive config store, which re-runs a watcher
// that re-checks the queue/crossfade every call — that's the "next:waiting"
// spam. localStorage is native, synchronous, per-origin persistent, and pokes
// nothing. ponytail: no fs, no new dep.
const LS_KEY = "cidementia:last";

const { plugin, setupConfig } = definePluginContext({
  name: "Cidementia",
  identifier: "cidr.techyt.cidementia",
  description: "Restores last played song on launch.",
  version: "1.0.0",
  pluginKitVersion: "4.0.0",
  author: "TechyTechster",
  repo: "https://github.com/TechyTechster/cidementia.git",
  setup() {
    const cfg = setupConfig({
      source: { type: "", id: "", name: "" },
      currentId: "",
      index: 0,
      position: 0,
    });


    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) cfg.value = { ...cfg.value, ...JSON.parse(saved) };
    } catch {}

    const persist = () => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(cfg.value));
      } catch {}
    };

    const store = (globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore;
    if (!store?.audioElement) return;
    const audio: HTMLAudioElement = store.audioElement;

    let holding = false;
    let lastSave = 0;
    let lastPos = -1;

    const capture = (force = false) => {
      if (holding) return;
      const ctx: any = store.queueSourceContext;
      if (!ctx?.collectionId) return;
      cfg.value.source = {
        type: String(ctx.type ?? ""),
        id: String(ctx.collectionId),
        name: String(ctx.collectionName ?? ""),
      };
      cfg.value.currentId = String((store.nowPlayingItem as any)?.id ?? "");
      cfg.value.index = store.queuePosition ?? 0;
      cfg.value.position = store.currentTime ?? audio.currentTime ?? 0;

      const now = Date.now();
      const pos = cfg.value.position;
      if (force || (pos !== lastPos && now - lastSave >= 2000)) {
        lastSave = now;
        lastPos = pos;
        persist();
      }
    };

    audio.addEventListener("timeupdate", () => capture());
    audio.addEventListener("pause", () => capture(true));
    window.addEventListener("beforeunload", () => capture(true));

    let restored = false;
    const restore = async () => {
      if (restored) return;
      const src = cfg.value.source;
      if (!src?.id) return;
      if (store.nowPlayingItem) return;
      restored = true;
      holding = true;

      const target = cfg.value.position || 0;
      const expectedId = String(cfg.value.currentId || "");
      const type = src.type.endsWith("s") ? src.type : `${src.type}s`;

      let aborted = false;
      const wasMuted = audio.muted;
      const wasVolume = store.volume;
      audio.muted = true;
      try {
        store.volume = 0;
      } catch {}

      const onGesture = () => {
        if (aborted) return;
        aborted = true;
        cleanup();
      };
      const cleanup = () => {
        window.removeEventListener("pointerdown", onGesture, true);
        window.removeEventListener("keydown", onGesture, true);
        audio.muted = wasMuted;
        try {
          store.volume = wasVolume;
        } catch {}
        holding = false;
      };
      const hijacked = () => {
        const npId = String((store.nowPlayingItem as any)?.id ?? "");
        return !!npId && !!expectedId && npId !== expectedId;
      };
      window.addEventListener("pointerdown", onGesture, true);
      window.addEventListener("keydown", onGesture, true);

      let ok = false;
      for (let attempt = 0; attempt < 6 && !ok && !aborted; attempt++) {
        try {
          await store.authorize?.();
          await store.setQueueFromCollection({ id: src.id, type });
          ok = (store.queue?.length ?? 0) > 0;
        } catch {}
        if (!ok) await new Promise((r) => setTimeout(r, 2000));
      }
      if (aborted) return;
      if (!ok) {
        restored = false;
        cleanup();
        return;
      }

      const q: any[] = store.queue || [];
      let jumpIdx = Math.min(Math.max(cfg.value.index || 0, 0), Math.max(q.length - 1, 0));
      if (expectedId) {
        const found = q.findIndex(
          (it) => String(it?.track?.id ?? it?.id ?? "") === expectedId,
        );
        if (found >= 0) jumpIdx = found;
      }

      try {
        await store.jumpToQueuePosition(jumpIdx);
      } catch {}
      if (aborted) return;

      const atTarget = () =>
        target < 1 || Math.abs((audio.currentTime || 0) - target) <= 1.5;
      const loaded = () => {
        const dur = store.duration ?? audio.duration ?? 0;
        return audio.readyState >= 2 && dur > 0 && !store.isSwitching && !store.isSeeking;
      };
      const ready = () => !!store.nowPlayingItem && loaded();

      let stable = 0;
      let tries = 0;
      const timer = setInterval(() => {
        if (aborted || hijacked()) {
          clearInterval(timer);
          cleanup();
          return;
        }
        tries++;

        if (!ready()) {
          if (!store.isPlaying) {
            try {
              store.play();
            } catch {}
          }
          if (tries >= 100) {
            clearInterval(timer);
            finish();
          }
          return;
        }

        if (store.isPlaying || !audio.paused) store.pause();
        const sk = audio.seekable;
        const canSeek =
          target >= 1 && sk && sk.length > 0 && sk.end(sk.length - 1) >= target;
        if (canSeek && Math.abs((audio.currentTime || 0) - target) > 1.5) {
          try {
            store.seekTo(target);
          } catch {}
          try {
            audio.currentTime = target;
          } catch {}
          store.pause();
        }

        stable = audio.paused && atTarget() ? stable + 1 : 0;

        if (stable >= 5 || tries >= 100) {
          clearInterval(timer);
          finish();
        }
      }, 200);

      function finish() {
        if (aborted) return;
        cleanup();
      }
    };

    subscribeEvent("app:ready", restore);
    setTimeout(restore, 3000);
  },
});

export default plugin;
