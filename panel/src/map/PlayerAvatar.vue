<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { playerSkin } from "./player-skins";

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 32 });
const fallback = new URL("../assets/minecraft/default-player.png", import.meta.url).href;
const skin = ref<string | null>(null), failed = ref(false);
const source = computed(() => !failed.value && skin.value ? skin.value : fallback);
watch(() => props.name, async (name, _, cleanup) => {
  let active = true;
  cleanup(() => { active = false; });
  skin.value = null; failed.value = false;
  const value = await playerSkin(name);
  if (active) skin.value = value;
}, { immediate: true });
</script>

<template>
  <span class="mc-player-avatar" :style="{ width: size + 'px', height: size + 'px' }" aria-hidden="true">
    <img :src="source" alt="" draggable="false" referrerpolicy="no-referrer" @error="failed = true" />
    <img class="mc-player-avatar-hat" :src="source" alt="" draggable="false" referrerpolicy="no-referrer" @error="failed = true" />
  </span>
</template>

<style scoped>
.mc-player-avatar { display: inline-block; position: relative; overflow: hidden; flex: 0 0 auto; border-radius: 0; background: #6a523d; }
.mc-player-avatar img { position: absolute; width: 800%; max-width: none; height: auto; top: -100%; left: -100%; image-rendering: pixelated; pointer-events: none; }
.mc-player-avatar .mc-player-avatar-hat { left: -500%; }
</style>
