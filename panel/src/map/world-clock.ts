import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from "vue";
import type { MapPlayerRoster } from "../../../shared/map-players";

interface Sample { ticks: number; sampledAt: number; receivedAt: number; rate: number }

/** Advance locally between RCON samples, using a monotonic browser clock. */
export function useWorldClock(roster: Ref<MapPlayerRoster | undefined>) {
  const now = ref(performance.now()), samples = shallowRef(new Map<string, Sample>());
  let timer: ReturnType<typeof setInterval> | undefined;
  watch(() => [roster.value?.worldTimes, roster.value?.worldTimeSampledAt, roster.value?.running, roster.value?.rconEnabled], () => {
    const value = roster.value, next = new Map<string, Sample>();
    now.value = performance.now();
    // A roster without samples is not a new anchor: keep counting from the last one.
    if (value && value.worldTimes === undefined) return;
    if (value?.running && value.rconEnabled) {
      const sampledAt = value.worldTimeSampledAt ?? now.value;
      for (const [world, ticks] of Object.entries(value.worldTimes ?? {})) {
        if (!Number.isInteger(ticks) || ticks < 0 || ticks >= 24000) continue;
        const previous = samples.value.get(world);
        // Cached server responses must not reset the local clock or imply a pause.
        if (previous?.sampledAt === sampledAt && previous.ticks === ticks) { next.set(world, previous); continue; }
        let rate = 20;
        if (previous) {
          const elapsed = (sampledAt - previous.sampledAt) / 1000;
          const measured = ((ticks - previous.ticks + 24000) % 24000) / elapsed;
          // Infer paused/slower/faster clocks, but treat large jumps (sleep/time set) as a new anchor.
          if (elapsed >= .5 && elapsed <= 10 && measured >= 0 && measured <= 200) rate = measured;
        }
        next.set(world, { ticks, sampledAt, receivedAt: now.value, rate });
      }
    }
    samples.value = next;
  }, { immediate: true, deep: true, flush: "sync" });
  const times = computed(() => Object.fromEntries([...samples.value].map(([world, sample]) => {
    // The clock runs from its single calibration until the page is reloaded.
    const elapsed = Math.max(0, (now.value - sample.receivedAt) / 1000);
    return [world, Math.floor(sample.ticks + elapsed * sample.rate) % 24000];
  })));
  const update = () => { if (typeof document === "undefined" || !document.hidden) now.value = performance.now(); };
  onMounted(() => {
    timer = setInterval(update, 1000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", update);
  });
  onBeforeUnmount(() => {
    clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", update);
  });
  return times;
}
