<script setup lang="ts">
import { ref } from "vue";
import { VAlert, VBtn, VCard, VCardActions, VCardText, VDialog, VSpacer } from "vuetify/components";
import PingFields from "./PingFields.vue";
import { t, usePingSettings, type PingInstanceInfo } from "./settings";

const props = defineProps<{
  instanceUuid: string;
  daemonId: string;
  instanceInfo?: PingInstanceInfo;
}>();
const emit = defineEmits<{ (event: "update"): void }>();
const open = ref(false);
const { form, loading, error, load, save } = usePingSettings(props.instanceUuid, props.daemonId);

function openDialog() {
  load(props.instanceInfo);
  open.value = true;
}

async function submit() {
  if (await save()) {
    emit("update");
    open.value = false;
  }
}

defineExpose({ open: openDialog, openDialog });
</script>

<template>
  <VDialog v-model="open" max-width="520" :persistent="loading">
    <VCard :title="t('TXT_CODE_40241d8e')">
      <VCardText>
        <PingFields :form="form" :disabled="loading" />
        <VAlert v-if="error" type="error" class="mt-4" role="alert">{{ error }}</VAlert>
      </VCardText>
      <VCardActions>
        <VSpacer />
        <VBtn :loading="loading" @click="submit">{{ t("TXT_CODE_abfe9512") }}</VBtn>
      </VCardActions>
    </VCard>
  </VDialog>
</template>
