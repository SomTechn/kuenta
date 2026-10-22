# Kuenta — Finanzas personales y familiares

App web instalable (PWA) en HTML, CSS y JavaScript puro, con Supabase como base de datos.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.html` | Estructura y diseño de la app |
| `app.js` | Toda la lógica |
| `config.js` | **El único archivo que debes editar**: URL y clave de Supabase |
| `sw.js` | Permite instalar la app y abrirla rápido (no guarda datos financieros) |
| `manifest.json` + `icons/` | Nombre, colores e íconos al instalarla en el teléfono |
| `vercel.json` | Encabezados de seguridad para Vercel |
| `supabase/migrations/` | Cambios de la base de datos (ejecutar en orden en SQL Editor) |
| `supabase/functions/send-push/` | Función que envía las notificaciones push |

## Puesta en marcha (una sola vez)

### 1. Base de datos
1. Crea un proyecto **nuevo** en Supabase.
2. Abre **SQL Editor**, pega `kuenta_schema.sql` completo y ejecútalo.

### 2. Autenticación (Supabase → Authentication)
- **Sign In / Providers → Email**: activo, con **Confirm email** encendido.
- **Passwords**: longitud mínima **8**, y activa **Leaked password protection** si tu plan lo permite.
- **URL Configuration**:
  - **Site URL**: la dirección final de tu app (ej. `https://kuenta.vercel.app`).
  - **Redirect URLs**: agrega esa misma URL. Así funcionan la confirmación de correo, la recuperación de contraseña y las invitaciones.
- **Emails** (opcional): traduce al español las plantillas de "Confirm signup" y "Reset password".

### 3. Conectar la app
Abre `config.js` y pega:
- `SUPABASE_URL` → Project Settings → API → Project URL
- `SUPABASE_ANON_KEY` → la clave **anon / publishable**

> Nunca uses la clave `service_role` en la app.

### 4. Publicar
- **Vercel**: sube la carpeta a GitHub y conéctala a Vercel. `vercel.json` aplica los encabezados de seguridad.
- **GitHub Pages**: también funciona; la política de seguridad viaja en el `<meta>` de `index.html`.

La app debe abrirse con **https** para que funcionen la huella, la instalación y la descarga de informes.

## Recordatorios, pagos programados, deudas y ahorro (actualización 06)

Funciones nuevas en **Más**:
- **Recordatorios**: avisos para registrar movimientos (por defecto 9:00 a. m., 1:00 p. m. y 8:00 p. m., editables, hasta 6). No insiste si registraste algo en las últimas 3 horas.
- **Pagos programados**: gastos recurrentes (semanal, cada 2 semanas, mensual, bimestral, trimestral, anual o una vez). Aviso un día antes y el mismo día; botón para registrar el pago y pasar al siguiente.
- **Deudas**: préstamos, tarjetas, hipotecas, cooperativas o deudas con familiares, incluso los que ya tienen tiempo (estima el saldo según la fecha del préstamo). Cuotas, interés sobre saldo o flat, registro de pagos (capital/interés, abonos extra), tabla de amortización, simulador con abono extra, comparación avalancha vs. bola de nieve y sugerencias personalizadas.
- **Ahorro inteligente**: plan de ahorro según tus ingresos y gastos reales, niveles (🌱 → 🦁), racha de días registrando, logros, gastos hormiga, regla 50/30/20 y retos virales (100 sobres, 52 semanas, 30 días sin gastos hormiga, semana sin gastar, redondeo) con imagen para compartir en historias (solo porcentajes, nunca montos).

### 1. Base de datos
Ejecuta `supabase/migrations/06_recordatorios_deudas_ahorro.sql` completo en **SQL Editor**. Es aditivo: no modifica datos existentes. Activa `pg_cron` y `pg_net` y programa la tarea `kuenta-reminders` cada 15 minutos, que crea los avisos en **Alertas**.

Sin los pasos siguientes la app ya funciona: los avisos aparecen en Alertas y los recordatorios llegan mientras Kuenta esté abierta.

### 2. Notificaciones push (para que lleguen con la app cerrada)
1. Genera las claves VAPID (una sola vez): `npx web-push generate-vapid-keys`.
2. Copia la **clave pública** en `config.js` → `VAPID_PUBLIC_KEY`.
3. Publica la función: `supabase functions deploy send-push --no-verify-jwt`.
4. En **Edge Functions → Secrets** agrega: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (`mailto:kuenta.app.hn@gmail.com`) y `CRON_SECRET` (una cadena larga al azar).
5. En **SQL Editor** guarda la URL y el secreto para la tarea programada:
   ```sql
   select vault.create_secret('https://<tu-proyecto>.supabase.co/functions/v1/send-push', 'kuenta_push_url');
   select vault.create_secret('<el mismo CRON_SECRET>', 'kuenta_cron_secret');
   ```
6. Cada persona activa las notificaciones en **Más → Recordatorios**. En iPhone primero hay que instalar Kuenta en la pantalla de inicio (iOS 16.4 o superior).

## Seguridad incluida
- Reglas **RLS** en todas las tablas; las operaciones sensibles (transferencias, familia, invitaciones) son funciones del servidor.
- Solo el dueño de la familia puede crear cuentas compartidas (lo valida la base de datos).
- Comprobantes en bucket **privado**, con enlaces temporales de 5 minutos.
- Todo texto del usuario se escapa antes de mostrarse (protección contra XSS).
- **PIN** guardado solo como hash PBKDF2 en el teléfono; tras 5 intentos fallidos se cierra la sesión.
- **Huella o Face ID** con WebAuthn como candado local.
- Content-Security-Policy, HSTS, bloqueo de iframes y librerías con verificación de integridad (SRI).
- Exportación a Excel protegida contra fórmulas maliciosas.

## Probar las invitaciones
1. Crea tu familia en **Más → Familia**.
2. Invita un correo: el enlace se copia solo.
3. La otra persona abre el enlace, crea su cuenta **con ese mismo correo** y queda unida.
