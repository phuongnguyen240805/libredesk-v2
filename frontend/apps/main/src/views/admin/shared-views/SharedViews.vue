<template>
  <AdminSplitLayout>
    <template #content>
      <router-view></router-view>
    </template>
    <template #help>
      <p>{{ $t('admin.sharedView.help') }}</p>
    </template>
  </AdminSplitLayout>
</template>

<script setup>
import AdminSplitLayout from '@/layouts/admin/AdminSplitLayout.vue'
</script>
