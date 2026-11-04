<script setup lang="ts">
import { computed } from "vue";
import { VAlert, VBtn, VCard, VCardActions, VCardText, VChip, VCombobox, VDialog, VPagination, VProgressLinear, VSelect, VSpacer, VTable, VTextField } from "vuetify/components";
import { PLAYER_GAME_MODES } from "../../../shared/players";
import { t } from "../settings";
import { usePlayers } from "./state";

const props = defineProps<{ instanceUuid: string; daemonId: string }>();
const { roster, reading, loading, acting, error, success, queryPrompt, enablingQuery, enableQuery, search, filter, page, form, names, online, pages, players, load, manage, execute } = usePlayers(props.instanceUuid, props.daemonId);
const filters = computed(() => [
  { value: "all", title: t("MC_PLAYERS_ALL") }, { value: "online", title: t("MC_PLAYERS_ONLINE") },
  { value: "whitelist", title: t("MC_PLAYERS_WHITELIST") }, { value: "operators", title: t("MC_PLAYERS_OPERATORS") },
  ...(roster.value?.edition === "bedrock" ? [] : [{ value: "banned", title: t("MC_PLAYERS_BANNED") }])
]);
const actions = computed(() => (roster.value?.actions || []).map(value => ({ value, title: t("MC_PLAYERS_ACTION_" + value.replace(/-/g, "_").toUpperCase()) })));
const modes = computed(() => PLAYER_GAME_MODES.map(value => ({ value, title: t("MC_PLAYERS_MODE_" + value.toUpperCase()) })));
const destinations = computed(() => [{ value: "coordinates", title: t("MC_PLAYERS_COORDINATES") }, { value: "player", title: t("MC_PLAYERS_TARGET_PLAYER") }]);
</script>

<template>
  <div class="mc-players-view">
    <VDialog v-model="queryPrompt" max-width="520" :persistent="enablingQuery" content-class="mc-players-query-confirm">
      <VCard :title="t('MC_PLAYERS_QUERY_PROMPT_TITLE')">
        <VCardText>{{ t('MC_PLAYERS_QUERY_PROMPT_TEXT') }}</VCardText>
        <VCardActions>
          <VSpacer />
          <VBtn :disabled="enablingQuery" @click="queryPrompt = false">{{ t('MC_PLAYERS_QUERY_CANCEL') }}</VBtn>
          <VBtn :loading="enablingQuery" :disabled="reading" @click="enableQuery">{{ t('MC_PLAYERS_QUERY_ENABLE') }}</VBtn>
        </VCardActions>
      </VCard>
    </VDialog>
    <div class="mc-players-toolbar">
      <VTextField v-model="search" :label="t('MC_PLAYERS_SEARCH')" hide-details density="compact" variant="solo-filled" clearable class="mc-players-search" @click:clear="search = ''" />
      <VSelect v-model="filter" :items="filters" :label="t('MC_PLAYERS_FILTER')" hide-details density="compact" variant="solo-filled" class="mc-players-filter" />
      <span class="mc-players-count">{{ t('MC_PLAYERS_ONLINE') }}: {{ roster?.onlineAvailable ? online : '—' }}<template v-if="roster?.maxPlayers"> / {{ roster.maxPlayers }}</template></span>
      <VBtn variant="text" :loading="loading" :disabled="reading || acting" @click="load()">{{ t('MC_PLAYERS_REFRESH') }}</VBtn>
    </div>
    <VProgressLinear v-if="loading" indeterminate color="primary" :aria-label="t('MC_PLAYERS_LOADING')" />
    <VAlert v-if="error" type="error" density="compact" role="alert">{{ error }}</VAlert>
    <VAlert v-if="success" type="success" density="compact" role="status">{{ success }}</VAlert>
    <VAlert v-if="roster && !roster.running" type="info" density="compact">{{ t('MC_PLAYERS_STOPPED') }}</VAlert>
    <VAlert v-for="warning in roster?.warnings || []" :key="warning" type="warning" density="compact">{{ t(warning) }}</VAlert>
    <VAlert v-if="roster?.edition === 'bedrock'" type="info" density="compact">{{ t('MC_PLAYERS_BEDROCK_LIMITS') }}</VAlert>
    <VTable density="compact" fixed-header class="mc-players-table">
      <thead><tr><th>{{ t('MC_PLAYERS_PLAYER') }}</th><th>{{ t('MC_PLAYERS_STATUS') }}</th><th>{{ t('MC_PLAYERS_ROLES') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="player in players" :key="player.id">
          <td>
            <div class="mc-player-name">{{ player.name || t('MC_PLAYERS_UNNAMED') }}</div>
            <div v-if="player.uuid || player.xuid" class="mc-player-id">{{ player.uuid || player.xuid }}</div>
          </td>
          <td><VChip size="small" variant="tonal" :color="player.online ? 'success' : undefined">{{ t(player.online === null ? 'MC_PLAYERS_UNKNOWN' : player.online ? 'MC_PLAYERS_ONLINE' : 'MC_PLAYERS_OFFLINE') }}</VChip></td>
          <td><div class="mc-player-roles">
            <VChip v-if="player.whitelisted" size="small" variant="tonal">{{ t('MC_PLAYERS_WHITELIST') }}</VChip>
            <VChip v-if="player.operator" size="small" variant="tonal" color="primary">{{ t('MC_PLAYERS_OPERATOR') }}</VChip>
            <VChip v-if="player.banned" size="small" variant="tonal" color="error" :title="player.banReason">{{ t('MC_PLAYERS_BANNED') }}</VChip>
          </div></td>
          <td><VBtn variant="text" size="small" :disabled="!player.name || acting" @click="manage(player)">{{ t('MC_PLAYERS_MANAGE') }}</VBtn></td>
        </tr>
        <tr v-if="!players.length"><td colspan="4" class="mc-players-empty" role="status">{{ t(loading ? 'MC_PLAYERS_LOADING' : search || filter !== 'all' ? 'MC_PLAYERS_NO_MATCH' : 'MC_PLAYERS_EMPTY') }}</td></tr>
      </tbody>
    </VTable>
    <VPagination v-if="pages > 1" v-model="page" :length="pages" :total-visible="5" density="compact" />
    <form class="mc-players-form" @submit.prevent="execute">
      <div class="mc-players-fields">
        <VCombobox v-model="form.player" :items="names" :label="t('MC_PLAYERS_PLAYER')" hide-details density="compact" variant="solo-filled" :disabled="acting" />
        <VSelect v-model="form.action" :items="actions" :label="t('MC_PLAYERS_ACTION')" hide-details density="compact" variant="solo-filled" :disabled="acting" />
        <VTextField v-if="form.action === 'kick' || form.action === 'ban'" v-model="form.reason" :label="t('MC_PLAYERS_REASON')" :maxlength="200" hide-details density="compact" variant="solo-filled" :disabled="acting" />
        <VSelect v-if="form.action === 'gamemode'" v-model="form.mode" :items="modes" :label="t('MC_PLAYERS_GAME_MODE')" hide-details density="compact" variant="solo-filled" :disabled="acting" />
        <VSelect v-if="form.action === 'teleport'" v-model="form.destination" :items="destinations" :label="t('MC_PLAYERS_DESTINATION')" hide-details density="compact" variant="solo-filled" :disabled="acting" />
      </div>
      <div v-if="form.action === 'teleport'" class="mc-players-fields mc-players-destination">
        <VCombobox v-if="form.destination === 'player'" v-model="form.target" :items="names" :label="t('MC_PLAYERS_TARGET_PLAYER')" hide-details density="compact" variant="solo-filled" :disabled="acting" />
        <template v-else>
          <VTextField v-model="form.x" label="X" type="number" :min="-30000000" :max="30000000" step="any" hide-details density="compact" variant="solo-filled" :disabled="acting" />
          <VTextField v-model="form.y" label="Y" type="number" :min="-2048" :max="2048" step="any" hide-details density="compact" variant="solo-filled" :disabled="acting" />
          <VTextField v-model="form.z" label="Z" type="number" :min="-30000000" :max="30000000" step="any" hide-details density="compact" variant="solo-filled" :disabled="acting" />
        </template>
      </div>
      <div class="mc-players-submit"><VBtn type="submit" variant="text" :loading="acting" :disabled="!roster?.running || reading || !form.player">{{ t('MC_PLAYERS_EXECUTE') }}</VBtn></div>
    </form>
  </div>
</template>

<style scoped>
.mc-players-view { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; padding: 12px; overflow-y: auto; }
.mc-players-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 8px; }
.mc-players-search { flex: 1; min-width: 180px; }
.mc-players-filter { flex: 0 1 160px; min-width: 130px; }
.mc-players-count { white-space: nowrap; font-variant-numeric: tabular-nums; font-size: 13px; }
.mc-players-table { flex: 1 1 240px; min-height: 180px; border-radius: 12px; }
.mc-players-table :deep(table) { min-width: 540px; }
.mc-players-table :deep(td) { padding-top: 8px; padding-bottom: 8px; }
.mc-player-name { font-weight: 500; }
.mc-player-id { font-size: 11px; opacity: .65; overflow-wrap: anywhere; }
.mc-player-roles { display: flex; flex-wrap: wrap; gap: 4px; }
.mc-players-empty { text-align: center; height: 120px; }
.mc-players-form { flex-shrink: 0; display: flex; flex-direction: column; gap: 12px; padding-top: 8px; }
.mc-players-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.mc-players-submit { display: flex; justify-content: flex-end; }
@media (max-width: 600px) {
  .mc-players-fields { grid-template-columns: minmax(0, 1fr); }
  .mc-players-destination { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .mc-players-destination :deep(.v-combobox) { grid-column: 1 / -1; }
}
</style>
