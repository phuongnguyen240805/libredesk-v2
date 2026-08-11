<template>
  <AdminSplitLayout>
    <template #content>
      <router-view></router-view>
    </template>

    <template #help>
      <p>{{ $t('admin.team.help.description') }}</p>
      <p>{{ $t('admin.team.help.detail') }}</p>
    </template>
  </AdminSplitLayout>
</template>

<script setup>
import AdminSplitLayout from '@/layouts/admin/AdminSplitLayout.vue'
</script>
