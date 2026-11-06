<script setup lang="ts">
import { t } from "../settings";
defineProps<{ x: number; y: number }>();
const compass = new URL("../assets/minecraft/compass.png", import.meta.url).href;
</script>

<template>
  <img class="mc-map-spawn-marker" :src="compass" :alt="t('MC_MAP_SPAWN')" :style="{ left: x + 'px', top: y + 'px' }" draggable="false" />
</template>

<style scoped>
.mc-map-spawn-marker { position: absolute; width: 28px; height: 28px; transform: translate(-50%, -50%); image-rendering: pixelated; pointer-events: none; }
</style>
