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
