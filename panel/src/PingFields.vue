<script setup lang="ts">
import { VTextField } from "vuetify/components";
import { t } from "./settings";

defineProps<{ form: { ip: string; port: string; type: number }; disabled?: boolean }>();
</script>

<template>
  <div class="mc-ping-fields">
    <p class="text-medium-emphasis">
      {{ t("TXT_CODE_57d1929e") }}<br />{{ t("TXT_CODE_6b175558") }}
    </p>
    <VTextField
      v-model="form.port"
      :label="t('TXT_CODE_f49149d0')"
      :hint="t('TXT_CODE_2ab036a4')"
      :placeholder="t('TXT_CODE_e2dc0156')"
      :disabled="disabled"
      type="number"
      min="0"
      max="65535"
      step="1"
      persistent-hint
      variant="solo-filled"
    />
    <VTextField
      v-model="form.ip"
      :label="t('TXT_CODE_2f59807a')"
      :hint="t('TXT_CODE_8e2be926')"
      :placeholder="t('TXT_CODE_ddc2de99')"
      :disabled="disabled"
      persistent-hint
      variant="solo-filled"
    />
  </div>
</template>

<style scoped>
.mc-ping-fields { display: flex; flex-direction: column; gap: 16px; }
.mc-ping-fields p { margin: 0; line-height: 1.6; }
</style>
