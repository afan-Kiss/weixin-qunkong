import { createRouter, createWebHashHistory } from 'vue-router'
import MainLayout from '../layout/MainLayout.vue'
import { ensureSession } from '../stores/auth'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('../pages/LoginPage.vue'), meta: { public: true } },
    { path: '/register', name: 'register', component: () => import('../pages/RegisterPage.vue'), meta: { public: true } },
    {
      path: '/',
      component: MainLayout,
      redirect: '/dashboard',
      children: [
        {
          path: 'dashboard',
          name: 'dashboard',
          component: () => import('../pages/DashboardPage.vue'),
        },
        {
          path: 'instances',
          name: 'instances',
          component: () => import('../pages/InstancesPage.vue'),
        },
        {
          path: 'groups',
          name: 'groups',
          component: () => import('../pages/GroupsMembersPage.vue'),
        },
        {
          path: 'chat-add-friend',
          name: 'chat-add-friend',
          component: () => import('../pages/ChatAddFriendPage.vue'),
        },
        {
          path: 'qr-tasks',
          name: 'qr-tasks',
          component: () => import('../pages/QrTasksPage.vue'),
        },
        {
          path: 'broadcast',
          name: 'broadcast',
          component: () => import('../pages/BroadcastPage.vue'),
        },
        {
          path: 'contacts',
          name: 'contacts',
          component: () => import('../pages/ContactsPage.vue'),
        },
        {
          path: 'wxids',
          name: 'wxids',
          component: () => import('../pages/WxidLookupPage.vue'),
        },
        {
          path: 'tasks',
          name: 'tasks',
          component: () => import('../pages/TasksPage.vue'),
        },
        {
          path: 'settings',
          name: 'settings',
          component: () => import('../pages/SettingsLogsPage.vue'),
        },
        {
          path: 'monitor',
          name: 'monitor',
          component: () => import('../pages/SessionMonitorPage.vue'),
        },
      ],
    },
  ],
})

router.beforeEach(async (to) => {
  const account = await ensureSession()
  if (!to.meta.public && !account) return { path: '/login', replace: true }
  if (to.meta.public && account) return { path: '/dashboard', replace: true }
  return true
})

export default router
