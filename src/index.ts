import {
  definePluginContext,
  subscribeEvent,
  saveConfig,
} from "@ciderapp/pluginkit";

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

    const store = (globalThis as any).__PLUGINSYS__?.Stores?.appleMusicStore;
    if (!store?.audioElement) {
      console.warn("[cidementia] appleMusicStore.audioElement missing");
      return;
    }
    const audio: HTMLAudioElement = store.audioElement;

    let holding = false;

    const capture = () => {
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
    };

    audio.addEventListener("timeupdate", capture);
    audio.addEventListener("pause", capture);
    window.addEventListener("beforeunload", () => {
      capture();
      void saveConfig();
    });

    let restored = false;
    const restore = async () => {
      if (restored) return;
      const src = cfg.value.source;
      if (!src?.id) {
        console.log("[cidementia] nothing saved to restore");
        return;
      }
      if (store.nowPlayingItem) {
        console.log("[cidementia] host already has a now-playing item");
        return;
      }
      restored = true;
      holding = true;

      const target = cfg.value.position || 0;
      const expectedId = String(cfg.value.currentId || "");
      const type = src.type.endsWith("s") ? src.type : `${src.type}s`;
      console.log(`[cidementia] restoring from ${src.type} "${src.name}" @ ${target}s`);

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
        console.log("[cidementia] user interacted - aborting restore");
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
        } catch (e) {
          console.warn(`[cidementia] setQueue attempt ${attempt + 1} failed`, e);
        }
        if (!ok) await new Promise((r) => setTimeout(r, 2000));
      }
      if (aborted) return;
      if (!ok) {
        console.warn("[cidementia] restore gave up building queue");
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
      } catch (e) {
        console.warn("[cidementia] jumpToQueuePosition failed", e);
      }
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
            console.warn("[cidementia] item never loaded into now-playing");
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

        if (stable >= 5) {
          clearInterval(timer);
          finish();
        } else if (tries >= 100) {
          console.warn("[cidementia] hold gave up at", audio.currentTime, "target", target);
          clearInterval(timer);
          finish();
        }
      }, 200);

      function finish() {
        if (aborted) return;
        console.log("[cidementia] settled, paused at", audio.currentTime);
        const guardUntil = Date.now() + 6000;
        const onPlay = () => {
          const cur = audio.currentTime || 0;
          const userResumed = target < 1 || cur > Math.max(2, target - 3);
          if (aborted || hijacked() || Date.now() > guardUntil || userResumed) {
            audio.removeEventListener("play", onPlay);
            cleanup();
            return;
          }
          store.pause();
          if (target >= 1) {
            try {
              store.seekTo(target);
            } catch {}
            try {
              audio.currentTime = target;
            } catch {}
          }
        };
        audio.addEventListener("play", onPlay);
        setTimeout(() => {
          audio.removeEventListener("play", onPlay);
          cleanup();
        }, 6500);
      }
    };

    subscribeEvent("app:ready", restore);
    setTimeout(restore, 3000);
  },
});

export default plugin;
