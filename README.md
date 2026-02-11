# Feature Tracker SDK

JavaScript / TypeScript SDK для отправки usage-событий в Feature Tracker.

Designed for simplicity and performance.

---

## ✨ Возможности

* автоматический batching
* минимальная настройка
* TypeScript support
* fire-and-forget отправка событий

---

## 📦 Установка

```bash
npm install @feature-tracker/sdk
```

*(публикация в npm планируется)*

---

## 🚀 Быстрый старт

```ts
import { FeatureTracker } from '@feature-tracker/sdk';

const tracker = new FeatureTracker({
  apiKey: 'YOUR_API_KEY',
});

tracker.track('checkout_started', {
  userId: 'user_123',
});
```

---

## ⚡ Batching

SDK автоматически:

* группирует события
* отправляет их пачками
* снижает сетевую нагрузку

Никакой дополнительной настройки не требуется.

---

## 🧠 Как это работает

```
App → SDK → Batch → Ingest API → Aggregation → Analytics
```

---

## 🔒 Безопасность

Авторизация через API Key.

⚠️ Никогда не используйте приватные ключи в публичных клиентах.

---

## 📈 Planned Features

* retry logic
* offline queue
* React hooks
* Next.js integration
* edge runtime support

---

## 📍 Part of Feature Tracker

SDK является частью Feature Tracker monorepo.

См. корневой README для общей архитектуры платформы.
