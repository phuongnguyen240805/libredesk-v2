<template>
  <div>
    <div class="flex justify-between mb-5">
      <div class="ml-auto">
        <Button @click="newRule">{{
          $t('automation.newRule')
        }}</Button>
      </div>
    </div>
    <div v-if="selectedTab">
      <AutomationTabs v-model:automationsTab="selectedTab" />
    </div>
  </div>
</template>

<script setup>
import { Button } from '@shared-ui/components/ui/button'
import { useRouter } from 'vue-router'
import { useStorage } from '@vueuse/core'
import AutomationTabs from '@/features/admin/automation/AutomationTabs.vue'

const router = useRouter()
const selectedTab = useStorage('automationsTab', 'new_conversation')
const newRule = () => {
  router.push({ name: 'new-automation', query: { type: selectedTab.value } })
}
</script>
