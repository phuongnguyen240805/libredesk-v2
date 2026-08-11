<template>
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-background">
    <div class="flex flex-col items-center text-center" style="transform: scale(3); transform-origin: center;">
      <Monitor class="w-12 h-12 text-muted-foreground mb-4" />
      <h2 class="text-lg font-semibold text-foreground mb-2">{{ t('globals.messages.smallScreenTitle') }}</h2>
      <p class="text-sm text-muted-foreground mb-6 max-w-sm">{{ t('globals.messages.smallScreenDescription') }}</p>
      <Button @click="$emit('dismiss')" variant="outline" size="sm">{{ t('globals.terms.continue') }}</Button>
    </div>
  </div>
</template>

<script setup>
import { Monitor } from 'lucide-vue-next'
import { Button } from '@shared-ui/components/ui/button'
import { useI18n } from 'vue-i18n'

defineEmits(['dismiss'])
const { t } = useI18n()
</script>
