<script setup>
import { Switch } from '@shared-ui/components/ui/switch'

defineProps({
  title: { type: String, default: '' },
  description: { type: String, default: '' },
  checked: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})

defineEmits(['update:checked'])
</script>

<template>
  <div class="space-y-2">
    <p class="text-sm font-medium text-foreground">{{ title }}</p>
    <div class="flex items-center gap-3">
      <Switch
        :checked="checked"
        :disabled="disabled"
        @update:checked="$emit('update:checked', $event)"
      />
      <p class="text-sm text-muted-foreground">{{ description }}</p>
    </div>
  </div>
</template>
