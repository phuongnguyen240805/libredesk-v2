<template>
  <AdminSplitLayout>
    <template #content>
      <router-view />
    </template>
    
    <template #help>
      <p>{{ $t('admin.businessHour.help.description') }}</p>
      <p>{{ $t('admin.businessHour.help.detail') }}</p>
    </template>
  </AdminSplitLayout>
</template>

<script setup>
import AdminSplitLayout from '@/layouts/admin/AdminSplitLayout.vue'
</script>