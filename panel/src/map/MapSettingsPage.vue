<script setup lang="ts">
import { VAlert, VBtn, VCard, VCardActions, VCardText, VDialog, VPagination, VProgressLinear, VSelect, VSwitch, VTextField } from "vuetify/components";
import { MAP_PAGE_PATH } from "../../../shared/map";
import { t } from "../settings";
import { useMapSettings } from "./useMapSettings";

const { settings, loading, ready, saving, saved, error, dirty, dialog, draft, loadingInstances, loadingWorlds,
  instanceError, worldError, editorError, search, page, maxPage, nodeItems, instanceItems, worldItems,
  canApply, load, loadInstances, selectNode, selectInstance, selectWorld, edit, apply, remove, save } = useMapSettings();
</script>

<template>
  <main class="mc-map-settings">
    <header class="mc-map-settings-header">
      <h1>{{ t("MC_MAP_MANAGE") }}</h1>
      <VBtn to="/plugins/config?plugin=mc-tools" variant="text">{{ t("MC_MAP_SETTINGS_BACK") }}</VBtn>
      <VBtn :to="MAP_PAGE_PATH" target="_blank" rel="noopener noreferrer" variant="text">{{ t("MC_MAP_PUBLIC_OPEN") }}</VBtn>
    </header>
    <VProgressLinear v-if="loading" indeterminate :aria-label="t('MC_MAP_LOADING')" />
    <VAlert v-if="error" type="error" density="compact" role="alert">{{ error }}</VAlert>
    <VBtn v-if="!ready && !loading" variant="text" @click="load">{{ t("MC_MAP_REFRESH") }}</VBtn>
    <template v-if="ready">
      <VSwitch v-model="settings.mapPageEnabled" :label="t('MC_MAP_PAGE_ENABLE')" :disabled="saving" color="primary" hide-details />
      <p>{{ t("MC_MAP_PAGE_ENABLE_HINT") }}</p>
      <h2>{{ t("MC_MAP_PUBLIC_MAPS") }}</h2>
      <p>{{ t("MC_MAP_PUBLIC_MAPS_HINT") }}</p>
      <div class="mc-map-settings-list">
        <div v-for="(map, index) in settings.publicMaps" :key="index" class="mc-map-settings-entry">
          <div class="mc-map-settings-name"><strong>{{ map.name }}</strong><small v-if="map.id">{{ map.id }}</small></div>
          <VBtn variant="text" :disabled="saving" @click="edit(index)">{{ t("MC_MAP_PUBLIC_EDIT") }}</VBtn>
          <VBtn variant="text" color="error" :disabled="saving" @click="remove(index)">{{ t("MC_MAP_PUBLIC_REMOVE") }}</VBtn>
        </div>
        <p v-if="!settings.publicMaps.length">{{ t("MC_MAP_PUBLIC_EMPTY") }}</p>
      </div>
      <VBtn variant="tonal" class="mc-map-add" :disabled="saving || settings.publicMaps.length >= 32" @click="edit()">{{ t("MC_MAP_PUBLIC_ADD") }}</VBtn>
      <footer class="mc-map-settings-footer">
        <VBtn color="primary" variant="flat" :loading="saving" :disabled="!dirty" @click="save">{{ t("MC_MAP_SETTINGS_SAVE") }}</VBtn>
        <span role="status">{{ saved ? t("MC_MAP_SETTINGS_SAVED") : dirty ? t("MC_MAP_SETTINGS_PENDING") : "" }}</span>
      </footer>
    </template>
    <VDialog v-model="dialog" max-width="640" scrollable>
      <VCard :title="t(draft.index < 0 ? 'MC_MAP_PUBLIC_ADD' : 'MC_MAP_PUBLIC_EDIT')">
        <VCardText class="mc-map-editor">
          <VSelect :model-value="draft.daemonId" :items="nodeItems" :label="t('MC_MAP_NODE')" variant="outlined" hide-details @update:model-value="selectNode" />
          <form v-if="draft.daemonId" class="mc-map-instance-search" @submit.prevent="loadInstances(1)">
            <VTextField v-model="search" :label="t('MC_MAP_INSTANCE_SEARCH')" maxlength="100" variant="outlined" density="compact" hide-details />
            <VBtn type="submit" variant="text" :loading="loadingInstances">{{ t("MC_MAP_SEARCH") }}</VBtn>
          </form>
          <VSelect :model-value="draft.instanceUuid" :items="instanceItems" :label="t('MC_MAP_INSTANCE')" :loading="loadingInstances" :disabled="!draft.daemonId || loadingInstances" :no-data-text="t('MC_MAP_INSTANCES_EMPTY')" variant="outlined" hide-details @update:model-value="selectInstance" />
          <VPagination v-if="maxPage > 1" :model-value="page" :length="maxPage" :total-visible="5" :disabled="loadingInstances" density="compact" @update:model-value="loadInstances" />
          <VAlert v-if="instanceError" type="error" density="compact" role="alert">{{ instanceError }}</VAlert>
          <VSelect :model-value="draft.world" :items="worldItems" :label="t('MC_MAP_WORLD')" :loading="loadingWorlds" :disabled="!draft.instanceUuid || loadingWorlds" :no-data-text="t('MC_MAP_NO_WORLDS')" variant="outlined" hide-details @update:model-value="selectWorld" />
          <VAlert v-if="worldError" type="error" density="compact" role="alert">{{ worldError }}</VAlert>
          <VTextField v-model="draft.name" :label="t('MC_MAP_PUBLIC_NAME')" maxlength="100" variant="outlined" hide-details />
          <VTextField v-model="draft.id" :label="t('MC_MAP_PUBLIC_ID')" :hint="t('MC_MAP_PUBLIC_ID_HINT')" maxlength="64" persistent-hint variant="outlined" />
          <VAlert v-if="editorError" type="error" density="compact" role="alert">{{ editorError }}</VAlert>
        </VCardText>
        <VCardActions>
          <VBtn @click="dialog = false">{{ t("MC_MAP_CANCEL") }}</VBtn>
          <VBtn color="primary" :disabled="!canApply" @click="apply">{{ t(draft.index < 0 ? "MC_MAP_PUBLIC_ADD" : "MC_MAP_SETTINGS_APPLY") }}</VBtn>
        </VCardActions>
      </VCard>
    </VDialog>
  </main>
</template>

<style scoped>
.mc-map-settings { display: flex; flex-direction: column; gap: 16px; padding: 24px; max-width: 1100px; margin: 0 auto; }
.mc-map-settings-header, .mc-map-settings-footer { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
.mc-map-settings-header h1 { flex: 1; font-size: 22px; }
.mc-map-settings h1, .mc-map-settings h2, .mc-map-settings p { margin: 0; }
.mc-map-settings h2 { font-size: 18px; }
.mc-map-settings p, .mc-map-settings small, .mc-map-settings-footer span { opacity: 0.75; }
.mc-map-settings-entry { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px 0; border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.12); }
.mc-map-settings-name { display: flex; flex: 1; min-width: 180px; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.mc-map-add { align-self: flex-start; }
.mc-map-editor { display: flex; flex-direction: column; gap: 20px; }
.mc-map-instance-search { display: flex; align-items: center; gap: 8px; }
.mc-map-settings-footer { padding-top: 8px; }
@media (max-width: 600px) { .mc-map-settings { padding: 12px; } .mc-map-settings-header h1 { flex-basis: 100%; } }
</style>
