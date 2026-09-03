# Docker Manager User Manual

> This manual describes the purpose and step-by-step operations for each module of the **Docker Manager** admin panel.
>
> Modules marked with 🔒 are **administrator-only**: they are not visible to regular users in the menu and their routes are guarded.

---

## Table of Contents

- [0. Installation](#0-installation)
- [1. Login & Getting Started](#1-login--getting-started)
- [2. Overview & Health Check](#2-overview--health-check)
- [3. Container Management](#3-container-management)
- [4. Container Templates 🔒](#4-container-templates-)
- [5. Container Orchestration 🔒](#5-container-orchestration-)
- [6. Image Management](#6-image-management)
- [7. Image Build 🔒](#7-image-build-)
- [8. Volumes / Storage / Networks](#8-volumes--storage--networks)
- [9. Compose](#9-compose)
- [10. App Store](#10-app-store)
- [11. Scheduled Tasks](#11-scheduled-tasks)
- [12. Files / Host Files / Host Terminal](#12-files--host-files--host-terminal)
- [13. Docker Engines 🔒](#13-docker-engines-)
- [14. Cloud Backup 🔒](#14-cloud-backup-)
- [15. Backup & Restore](#15-backup--restore)
- [16. Swarm 🔒](#16-swarm-)
- [17. Database Explorer](#17-database-explorer)
- [18. Image Hub](#18-image-hub)
- [19. Event Stream](#19-event-stream)
- [20. Operation Logs](#20-operation-logs)
- [21. Notifications 🔒](#21-notifications-)
- [22. Reverse Proxy Sites 🔒](#22-reverse-proxy-sites-)
- [23. Firewall 🔒](#23-firewall-)
- [24. App Store & System Settings](#24-app-store--system-settings)
- [25. Reference: Form Fields](#25-reference-form-fields)
- [26. FAQ](#26-faq)
- [27. Image Vulnerability Scanning](#27-image-vulnerability-scanning)
- [28. Cross-Engine Container Migration / Image Transfer](#28-cross-engine-container-migration--image-transfer)
- [29. Cross-Engine Aggregated Overview](#29-cross-engine-aggregated-overview)
- [30. Global Search](#30-global-search)
- [31. Container Resource Dashboard](#31-container-resource-dashboard)
- [32. Monitoring History](#32-monitoring-history)
- [33. Template / Image Hub Enhancements](#33-template--image-hub-enhancements)
- [34. Configuration Import / Export](#34-configuration-import--export)
- [35. Webhook / Git Auto Deployment](#35-webhook--git-auto-deployment)
- [36. Ops Toolbox](#36-ops-toolbox)
- [37. Port Map](#37-port-map)
- [38. Prometheus / Grafana Integration](#38-prometheus--grafana-integration)
- [39. Security Baseline Scanning 🔒](#39-security-baseline-scanning-)
- [40. High-Risk Operation Approval Flow](#40-high-risk-operation-approval-flow)
- [41. AI Assistant](#41-ai-assistant)
- [42. Help Center](#42-help-center)
- [43. Kubernetes Read-only Inspection](#43-kubernetes-read-only-inspection)

> **Screenshot placeholders**: images referenced below point to the `docs/images/` directory. Drop screenshots named after each image link into that folder to display them.

---

## 0. Installation

### 0.1 Prerequisites

| Dependency | Version | Notes |
| --- | --- | --- |
| Node.js | ≥ 22 | Auto-installed by install script |
| Docker Engine | Latest stable | Auto-installed by install script |
| Docker Compose | v2 plugin | Auto-installed by install script |
| OS | Ubuntu 24.04 / Debian 12+ / CentOS 7+ / RHEL / Windows 10+ / macOS 13+ / macOS 13+ / macOS 13+ | |

> Default credentials: `admin` / `admin888`. Change the password immediately after first login.

### 0.2 Option 1: APT Repository (Ubuntu / Debian)

```bash
# Add GPG key
curl -fsSL https://13861419.github.io/dockerDesktop/apt/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/docker-manager.gpg

# Add APT source
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-manager.gpg] https://13861419.github.io/dockerDesktop/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/docker-manager.list

# Install
sudo apt-get update
sudo apt-get install -y docker-manager

# Check service status
sudo systemctl status docker-manager
```

Then visit `http://<server-ip>:9528`.

### 0.3 Option 2: YUM Repository (CentOS / RHEL)

```bash
# Add YUM source
sudo tee /etc/yum.repos.d/docker-manager.repo <<'EOF'
[docker-manager]
name=Docker Manager
baseurl=https://13861419.github.io/dockerDesktop/yum
enabled=1
gpgcheck=0
EOF

# Install
sudo yum install -y docker-manager
# Or on CentOS 8+ / RHEL:
sudo dnf install -y docker-manager

# Check service status
sudo systemctl status docker-manager
```

Then visit `http://<server-ip>:9528`.

### 0.4 Option 3: Manual Deb / RPM Install

Download from [GitHub Releases](https://github.com/13861419/dockerDesktop/releases/latest):

```bash
# Ubuntu / Debian
sudo dpkg -i docker-manager-*.deb
sudo apt-get install -f

# CentOS / RHEL
sudo rpm -ivh docker-manager-*.rpm
# Or:
sudo yum install -y docker-manager-*.rpm
```

The install script automatically creates the service user, configures systemd, and opens the firewall port.

### 0.5 Option 4: Windows Install

Download `DockerManager-windows-amd64.zip` from [GitHub Releases](https://github.com/13861419/dockerDesktop/releases/latest).

#### Batch Install

1. Extract the zip to a target directory (e.g. `C:\DockerManager`).
2. Right-click `install.bat` → **Run as administrator**.
3. Wait for the service to register and start.

This registers a Windows service (via NSSM), adds a Start Menu shortcut, and starts a system tray icon.

#### NSIS Installer

Run `DockerManager-setup-*.exe` and follow the wizard for a standard install/uninstall flow.

### 0.6 Option 5: Docker Run

```bash
docker pull ghcr.io/13861419/dockerdesktop:latest

docker run -d \
  --name docker-manager \
  -p 9528:9528 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v docker-manager-data:/data \
  --restart=unless-stopped \
  ghcr.io/13861419/dockerdesktop:latest
```

> The Docker socket (`/var/run/docker.sock`) must be mounted for the panel to manage containers.

### 0.7 Option 6: npm Global Install

```bash
npm install -g @13861419/docker-manager
docker-manager
```

### 0.8 Option 7: Source (Development Mode)

```bash
git clone https://github.com/13861419/dockerDesktop.git
cd dockerDesktop
npm install

# Backend (port 9528)
npm run dev:server

# Frontend (port 9526), in another terminal
npm run dev:web
```

Visit `http://localhost:9526`.

### 0.9 Service Management (Linux)

```bash
sudo systemctl start docker-manager
sudo systemctl stop docker-manager
sudo systemctl restart docker-manager
sudo systemctl status docker-manager
sudo systemctl enable docker-manager

# View logs
journalctl -u docker-manager -f
```

### 0.10 Data Directory

| Platform | Path | Notes |
| --- | --- | --- |
| Linux | `/var/lib/docker-manager/` | Core file: `docker-manager.db` (SQLite) |
| Windows | `%PROGRAMDATA%\DockerManager\data\` | Same |
| Docker | Container `/data` (mount via `-v`) | Same |

To back up, copy the entire data directory.

---

## 1. Login & Getting Started

### 1.1 Access

| Mode | URL | When to use |
| --- | --- | --- |
| Development | `http://localhost:9526` | Running from source |
| Production / installed | `http://localhost:9528` | Packaged deployment |

> In production the backend serves the frontend static files, so just visit the backend port.

### 1.2 Default Credentials

| Item | Value |
| --- | --- |
| Default username | `admin` |
| Default password | `admin888` |
| Session lifetime | 24 hours |

### 1.3 Login Steps

1. Open the URL in a browser to reach the login page.
2. Enter username and password, then click the **Login** button.
   > The button text is "Log in" (rendered as "登 录" with a space in the Chinese UI) — this is normal.
3. You are redirected to the **Overview** page. The current username and role (Admin / User) are shown in the top corner.
4. Use the avatar / menu in the top-right to **log out**.

> Sessions use an in-memory token; they expire when the service restarts.

---

## 2. Overview & Health Check

### 2.1 Overview (`/`)

The default landing page shows:

- **Docker engine info**: version, status, and counts of containers / images / volumes / networks.
- **Live resource graphs**: CPU, memory, network, and disk usage (ECharts).
- **GPU monitoring (optional)**: on NVIDIA hosts, GPU utilization / VRAM / temperature via `nvidia-smi`.

All data refreshes in real time — no manual action needed.

![Overview](../images/overview.png)

### 2.2 Health Check (`/health`)

- Shows engine connection health and key component status.
- Useful to quickly identify engine dropouts or anomalies.

![Health check](../images/health.png)

---

## 3. Container Management

### 3.1 Container List

Menu: **Containers** (`/containers`)

- Lists containers with name, image, status, ports, resource usage, and creation time.
- Top bar offers **status filter** (Running / all) and a **search box** (by name / image).
- A counter shows the number of running containers.

### 3.2 Create a Container

1. Click **"+ Create container"**.
2. Fill the create dialog: image, name, port mapping, environment variables, volume mounts, etc.
3. Optionally choose **"Create from template"** and pick a template saved under **Container Templates** to reuse its configuration.
4. Click **Create**.

### 3.3 Container Actions

The **Actions** column of each row offers:

- **Start / Stop** — toggle running state.
- **Restart**.
- **Delete** (optionally remove associated volumes).
- **Clone** — create a new container from the current configuration.
- **Rename**.
- **Logs / Details** — open the detail page.
- **Restart policy** — `no` / `always` / `on-failure` / `unless-stopped`.

### 3.4 Container Detail Page

Click a container to open its detail page (`containerDetail`), which provides:

1. **Basic info**: status, image, ports, networks, mounts, env vars, restart policy.
2. **Logs**: streaming standard output.
3. **Built-in Web Terminal**: interact with the container's `sh` / `bash` (xterm.js + WebSocket).
4. **Export config**: export the container configuration as JSON (can be saved as a template).
5. **File browser**: see the Files section.

![Container list](../images/containers.png)

---

## 4. Container Templates 🔒

Menu: **Container Templates** (`/templates`, admin only)

- Displays saved deployment templates as a **card grid**.
- Each card shows the template name, image, description, creation time, and a collapsible **config JSON** preview.

### 4.1 Create a Template

1. Click **"+ New template"**.
2. Fill in:
   - **Name** (required)
   - **Description** (optional)
   - **Image** (optional, e.g. `nginx:latest`)
   - **config (JSON)**: matches the exported container config structure; paste it here.
3. Click **Create**.

### 4.2 Edit a Template

- Click **Edit** on the card, modify the values, then click **Save**.

### 4.3 Use a Template

- Templates are used in **Containers → Create → From template**.
- Clicking **Use** on a card shows a hint to go to the Containers page.

### 4.4 Delete a Template

- Click **Delete** on the card, then confirm with **Delete**. This cannot be undone.

### 4.5 Search

- The search box at the top filters in real time by **name / description / image**; the header shows matched vs. total counts.

![Templates](../images/templates.png)

---

## 5. Container Orchestration 🔒

Menu: **Orchestrate** (`/orchestrate`, admin only)

- Unified orchestration of multi-container applications (start/stop, scale, etc.).
- Operations here are recorded in the operation logs.

![Orchestration](../images/orchestrate.png)

---

## 6. Image Management

Menu: **Images** (`/images`)

### 6.1 Image List

- Shows image with name/tag, size, image ID, build time, and pulled time, plus totals for image count / total size / unused images.

### 6.2 Pull an Image

1. Click **"Pull image"**.
2. Enter the reference (e.g. `nginx:latest`).
3. Select an image source (optionally a mirror accelerator). The system tries sources in order and retries on failure.
4. Refresh the list when done.

### 6.3 Image Actions

- **Delete** the image (remove containers first if in use).
- **Push / Import / Export**.
- **Tag** — add a new tag.
- **Prune** — clean up dangling images.
- **View detail / build history** — open the `imageDetail` page.

![Image list](../images/images.png)

---

## 7. Image Build 🔒

Menu: **Image Build** (`/build`, admin only)

1. Select a host directory containing a `Dockerfile`.
2. Configure **build args** and the **noCache** switch.
3. Click **"Start build"** and watch the streaming build log.
4. Builds are persisted as **build history**: browse past logs, **reuse** last configuration, or **clear** history.

![Image build](../images/build.png)

---

## 8. Volumes / Storage / Networks

### 8.1 Volumes (`/volumes`)

- Lists name, driver, status, mount point, and creation time.
- **New volume** — set a name and driver.
- **Delete** — only for unused volumes.
- **Detail** — view mount points and using containers.
- **Prune** — reclaim volumes not referenced by any container.

### 8.2 Storage (`/storage`)

- Shows disk usage by partition.
- **One-click cleanup** — reclaim space from dangling images, unused volumes, etc.

### 8.3 Networks (`/networks`)

- Lists name, driver, scope, and internal flag.
- **New network** — enter the **network name** (first input) and other parameters to create.
- **Delete** — remove unused networks.
- **Detail** — view connected containers and IPAM subnet.
- **Prune** — reclaim networks without containers.

![Volumes & networks](../images/volumes-networks.png)

---

## 9. Compose

Menu: **Compose** (`/compose`)

- Lists Compose projects with name, status, file, and path.
- **New / edit**: enter or paste `docker-compose.yml` content.
- Actions: **Up**, **Down**, **Pull**, **Build**.
- Expand to inspect the Compose file content and structure (port mapping, etc.).

![Compose](../images/compose.png)

---

## 10. App Store

Menu: **App Store** (`/appstore`)

1. Browse the built-in app catalog (cards with category filters).
2. Click an app card to view details, version, and ports.
3. Fill in **app parameters** (ports, image source, etc.; you may use the default mirror).
4. Click **Install** to deploy with one click; installed instances show their status.
5. Stop / uninstall installed instances as needed.

![App Store](../images/appstore.png)

---

## 11. Scheduled Tasks

Menu: **Scheduled Tasks** (`/tasks`)

- Manage scheduled automation (periodic runs / container operations by trigger).
- **New task**: choose task type, schedule (cron / interval), target container, and action.
- Enable / pause, run now, delete, and edit tasks.
- **Run logs** show the result and failure reason of each run.

![Scheduled tasks](../images/tasks.png)

---

## 12. Files / Host Files / Host Terminal

### 12.1 Container Files (`/files`)

- **Browse** a container's file system.
- **Upload / download / edit** files inside the container.

### 12.2 Host Files (`/hostfiles`)

- Browse the host file system (handle with care — system-level reads/writes).
- Basic upload / download / edit support.

### 12.3 Host Terminal (`/hostterminal`)

- Open a host remote terminal (xterm) to run host commands.
- **Administrators only** — proceed with caution.

![Files & terminal](../images/files-terminal.png)

---

## 13. Docker Engines 🔒

Menu: **Docker Engines** (`/engines`, admin only)

- Manage multiple Docker engine endpoints (local or remote).
- **New engine**: enter an endpoint (`npipe://` / `tcp://` / `unix://`, e.g. `tcp://192.168.1.10:2375`).
- **Edit / Delete** existing endpoints.
- **Set current** — switch the active engine.
- Endpoints are auto-detected and validated.

![Docker engines](../images/engines.png)

---

## 14. Cloud Backup 🔒

Menu: **Cloud Backup** (`/cloudbackup`, admin only)

- Configure cloud backup targets: **S3 / OSS / WebDAV**.
- **New target**: fill in type, name, endpoint, bucket, credentials.
- **Connectivity test** — verify the target can be written.
- **Upload** — push backup files to the cloud target.
- Cloud backups can be combined with local backups under Backup & Restore.

![Cloud backup](../images/cloudbackup.png)

---

## 15. Backup & Restore

Menu: **Backup & Restore** (`/backups`)

### 15.1 Create a Backup

- Backup types: **DATA (panel data) / Compose / Volumes / Sites**.
- Click "New backup", pick a type, and run it to create a backup record.

### 15.2 Restore & Download

- From the backup list you can **download**, **restore**, or **delete** backups.
- You can **upload a backup to the cloud** (after configuring a target under Cloud Backup).

### 15.3 Data Migration

- Copy the whole `data/` directory (core file `docker-manager.db`) to back up or migrate the configuration.

![Backup & restore](../images/backups.png)

### 15.4 Panel Database Backup Management (Settings Center)

Menu: **Settings → Panel Database Backup Management** (admin only)

- **Backup now**: takes a consistent snapshot of the panel's own SQLite database (`VACUUM INTO`, no downtime), stored under the data directory `db-backups/`.
- **Restore**: one-click restore from the list; takes effect immediately after the current data is overwritten (a panel restart is recommended). Files are validated for the SQLite format before restore, and an integrity check runs afterwards.
- **Download / Delete**: download backup files for archival or delete them manually.
- **Scheduled backup**: create a task of type **Database Backup** under Scheduled Tasks; retention is controlled by the system parameter "Panel database backup retention count" (default 7, 0 = no auto-cleanup).

![Panel database backup management](../images/settings-db-backup.png)

---

## 16. Swarm 🔒

Menu: **Swarm** (`/swarm`, admin only)

- View / manage Docker Swarm cluster nodes and services.
- Available when the host has initialized or joined a Swarm; optional for most setups.

![Swarm](../images/swarm.png)

---

## 17. Database Explorer

Menu: **Databases** (`/databases`)

- Visually explore containerized **MySQL / PostgreSQL / Redis** instances (**read-only protection**; it does not modify data directly).

### 17.1 Add an Instance

1. Click "Add instance".
2. Fill in name, type, and connection info (host / port / username / password).
3. Save, then open the instance to run visual queries.

### 17.2 Query & View

- Open an instance to view table structure, run read-only queries, and browse data.
- Provides read-only display only — **no destructive write operations**.

![Databases](../images/databases.png)

---

## 18. Image Hub

Menu: **Image Hub** (`/hub`)

### 18.1 Source Configuration

- View / configure **Docker mirror sources** (built-in defaults such as Xuanyuan, 1ms).
- **Search source**: used to search Docker Hub online. Replace if the default doesn't support search (see FAQ).

### 18.2 Online Search & Quick Pull

- **Search** Docker Hub images online by keyword.
- **Common images** — one-click quick pull of popular images (nginx, redis, mysql, etc.).
- Search results can jump straight to the Images page to pull.

![Image Hub](../images/hub.png)

---

## 19. Event Stream

Menu: **Event Stream** (`/events`)

- Watch the Docker engine event stream in real time (create / start / stop / die, etc.).
- Events are **persisted to SQLite**; query **historical events**.
- Support **Export CSV** and **Clear** history.

![Events](../images/events.png)

---

## 20. Operation Logs

Menu: **Operation Logs** (`/operation-logs`)

- Audit trail of admin management operations (deletes, creates, config changes) for tracking and security.

![Operation logs](../images/operation-logs.png)

---

## 21. Notifications 🔒

Menu: **Notifications** (`/notifications`, admin only)

- Configure alert channels (Webhook / mail / DingTalk / Feishu / Telegram / WeCom / Slack, etc.) and alert rules.
- **Container rules**: set alert triggers for specific containers (exit, restart loop, resource anomalies).
- Alerts are pushed to targets per rules; the list shows triggered alerts with timestamps.
- **Consecutive-cycle debounce**: rules may require N consecutive sampling cycles over the threshold before firing, filtering transient spikes.
- **Multi-channel routing**: the "Push routing" card offers three policies — first enabled channel only (legacy default) / all enabled channels / per-level routing (warn / danger / recovery each with its own target channels; a level with no selected channels falls back to the first enabled channel).
- **Push aggregation (anti-storm)**: system parameter `alerts.pushAggWindowSec` (default 60s, 0 = off). Multiple warn/danger alerts within the window are merged into a single digest (up to 5 original messages plus a total count), and different levels are never mixed into one digest; **recovery notices are always pushed immediately**. Aggregated alert records are still stored individually with push status "aggregated"; aggregated pushes do not trigger AI diagnosis.
- **Channel delivery stats**: the "Delivery stats" card aggregates the last 7 days of pushes per channel — success / failure counts, delivery rate, last success / failure times — plus a recent-failure list with causes, making it easy to spot misconfigured channels. It covers every push path: alerts / recovery / self-heal / approvals / AI diagnosis / weekly reports / test pushes.

![Notifications](../images/notifications.png)

---

## 22. Reverse Proxy Sites 🔒

Menu: **Sites (proxy / port mapping)** (`/sites`, admin only)

- Manage **reverse proxy / port mapping** for sites via a proxy container.
- **New site**: enter domain, upstream address, and port.
- **Start / stop** and config **reload**.
- **SSL certificates**: view status / expiry and **upload a certificate** to replace it (the "Upload certificate" button).

![Sites](../images/sites.png)

---

## 23. Firewall 🔒

Menu: **Firewall** (`/firewall`, admin only)

- Manage Windows firewall **inbound port allow** rules (based on `netsh`).
- **New rule**: enter a port and protocol to allow inbound traffic.
- Delete unneeded allow rules.
- Requires admin privileges; system prompts may appear.

![Firewall](../images/firewall.png)

---

## 24. App Store & System Settings

### 24.1 System Settings (`/settings`)

- **Theme**: switch light / dark.
- **Language**: switch the UI language (Chinese / English) in the "About" card → "Interface Language". The preference takes effect immediately and is stored in the browser. v0.6.0 shipped an i18n skeleton with an English pack covering the core layer; coverage expanded batch by batch (v0.7.0–v0.9.0), and as of v1.0.0 **all pages are fully covered in both languages** (untranslated strings still fall back to Chinese).
- **Users & passwords**: admins can add / remove users and change passwords (linked to login auth).
- **Role management (RBAC)**: admins can create custom roles with per-action whitelists (14 resource-domain permissions in 6 groups: containers / images / volumes / networks / compose / self-heal); built-in admin / user / auditor are locked, the operator permission set is adjustable; roles still in use cannot be deleted. Role permissions apply to the resource domain only — user management, system settings, engine switching, etc. always require an admin. Role members see exactly the action buttons their permissions allow (unauthorized buttons are hidden); high-risk entry points such as container terminals are granted by the same permission set.
- **Two-factor authentication (2FA)**: since v1.1.0 the panel ships TOTP-based 2FA (RFC 6238). In "Settings → Security → Two-Factor Verification" click "Generate Key", scan the otpauth URI (or enter the Base32 key manually) with an authenticator app such as Google Authenticator, then confirm with the first 6-digit code. Once enabled, login requires the code after the password (a failed ticket expires after 2 minutes and you must log in again). Disabling requires the current code.
- **Active sessions**: the same card lists all active sessions (ID / user / IP / sign-in time) with a "current" badge; revoke a single session or "Revoke other sessions" to sign out other devices in one click. Admins can set "Max sessions per user" in "System Parameters → Security" (oldest session is evicted beyond the limit; 0 = unlimited).
- **IP allowlist**: configure a global allowlist (system parameter `security.ipAllowlist`) and per-user allowlists (inline editing in the user table) — IPs or IPv4 CIDRs (e.g. `192.168.1.0/24`), comma-separated. The per-user list takes precedence over the global one; when both are empty access is unrestricted. The allowlist is enforced at login and on every API request; non-matching IPs get 403. **Make sure the admin workstation IP is included in the global allowlist to avoid locking yourself out.**
- **Password policy**: the "Security" group of system parameters offers minimum length (default 6), require upper / lower case letters and digits, and password expiry days (a forced password change at next login after expiry; 0 = never). The policy applies to user creation and password changes alike.
- **Long-term metrics history (v1.2.0)**: beyond the 7-day raw samples for hosts and containers, the panel aggregates data hourly (CPU avg/max, memory avg/max, disk, network deltas) and keeps it for **90 days**. The time-window selectors of the overview "Resource Monitoring" and the container detail "Resource Curves" now include **30d / 90d** (one point every 6 / 12 hours), ideal for week- and month-scale capacity trends.
- **Scheduled vulnerability scanning (v1.2.0)**: a new scheduled task type `vulnScan` scans an explicit image list (comma-separated; leave empty to auto-scan the first N local images, default 20). Results are stored in the scan history and diffed against the previous run by CVE id — new Critical / High findings are pushed to all enabled notification channels. The scan history is shown in the image detail page's "Vulnerability Scanning (Trivy)" card ("Scan History" table). Tasks skip gracefully when Trivy is not installed.
- **Multi-level approval chain (v1.3.0)**: list action types in "Two-step approval actions" (System Parameters → Security), e.g. `container.delete,image.deleteBatch`. Those tickets require **two sign-offs** — level 1 by an operator or admin, the **final level by an admin**. The approval center shows "Level 1/2" progress and the full decision trail (who / when / why); each level publishes a progress notification. Every ticket carries a unique number `AP-YYYYMMDD-ID` (shown in lists, notifications and gate responses; legacy rows are back-filled automatically) for easy ticketing references.
- **Approval expiry reminder (v1.3.0)**: when a pending ticket reaches 3/4 of its TTL (`approvals.ttlHours`), a one-time reminder is pushed; tickets still expire automatically past the TTL. Expiry cleanup now runs on a timer instead of lazily on query.
- **OpenAPI docs (v1.4.0)**: `GET /api/openapi.json` (login required) returns an OpenAPI 3.0 skeleton of the backend covering 34 paths across auth / monitoring / containers / images / volumes / networks / compose / scheduled tasks / approvals / system, with methods, summaries, query parameters and Bearer auth. The "API Docs" page in the sidebar groups and searches them for integration and automation (fields follow the route implementations).
- **PWA & mobile**: the panel can be installed to a home screen (manifest + Service Worker app-shell cache, never intercepting /api and /ws); below 768px a mobile layout kicks in (collapsible sidebar, horizontally scrollable tables, touch-friendly controls).

![Settings](../images/settings.png)

---

## 25. Reference: Form Fields

The fields of each create / edit dialog are listed below. Items marked `*` are required.

### 25.1 Docker Engine Endpoint (`/engines`)

| Field | Description | Required |
| --- | --- | --- |
| Engine name * | e.g. "Server B" | Yes |
| Endpoint * | `npipe://` / `tcp://host:2375` / `unix://`, e.g. `tcp://192.168.1.10:2375` | Yes |

> Engine identity/connection is determined by the endpoint scheme (npipe / tcp / unix); there is no separate TLS field.

### 25.2 Cloud Backup Target (`/cloudbackup`)

| Field | Description | Required |
| --- | --- | --- |
| Type | `WebDAV` / `S3` / `Aliyun OSS` | No |
| Name * | e.g. "My NAS / Tencent COS" | Yes |
| Endpoint * | WebDAV server; OSS `https://oss-cn-hangzhou.aliyuncs.com`; S3 `https://s3.region.amazonaws.com` | Yes |
| Bucket | Only for S3 / OSS, e.g. `my-bucket` | S3/OSS only |
| Region | Only for S3, e.g. `us-east-1` | No |
| Base path (optional) | e.g. `backup/app1` | No |
| AccessKey / Username | Username for WebDAV; access key ID for S3/OSS | No |
| Password / SecretKey | Password (WebDAV) or SecretKey (S3/OSS); blank keeps the current on edit | No |

### 25.3 Database Instance (`/databases`)

| Field | Description | Required |
| --- | --- | --- |
| Name * | e.g. "Primary DB" | Yes |
| Type | `MySQL` / `PostgreSQL` / `MariaDB` / `Redis` | Yes |
| Host * | `127.0.0.1` or container name | Yes |
| Port * | `3306` / `5432` / `6379` | Yes |
| Username | `root` (optional) | No |
| Password | Blank keeps the current / passwordless connection on edit | No |

> New database (MySQL/MariaDB): database name (required) + charset (`utf8mb4` / `utf8mb3` / `utf8` / `gbk` / `latin1`, immutable after creation).
> Redis query: match pattern (e.g. `*`, `user:*`) + limit.

### 25.4 Site (proxy / port mapping, `/sites`)

| Field | Description | Required |
| --- | --- | --- |
| Domain * | e.g. `app.example.com` | Yes |
| Upstream * | `localhost` / `127.0.0.1` / container name | Yes |
| Upstream port * | 1–65535 | Yes |
| Listen port | Host external port (HTTP 80 default, HTTPS 443 recommended) | No |
| Enable HTTPS | Shows "certificate file path" when enabled | No |
| Certificate path | Host absolute path, e.g. `C:\certs\app.pem` | HTTPS only |
| Advanced: WebSocket / gzip / access control | Each a toggle | No |
| Access control user / password | Shown when access control enabled | Required when enabled |
| Rate limit | e.g. `5r/s` or `10r/m` | No |
| Client body limit | e.g. `10m` (default `1m`) | No |
| Proxy timeout (s) | Default 60 | No |
| Custom config snippet | Extra nginx directives (textarea) | No |

### 25.5 Notifications (`/notifications`)

**Channels**: channel name *, channel type (`Webhook` / `SMTP mail` / `DingTalk bot` / `Feishu bot` / `Telegram` / `WeCom bot` / `Slack`).

| Type | Fields |
| --- | --- |
| Webhook | Webhook URL *, Secret |
| SMTP | SMTP host *, port *, use SSL, account, password, sender *, recipients (comma-separated) * |
| DingTalk | access_token *, signing Secret |
| Feishu | Webhook URL * |
| Telegram | Bot Token * (stored encrypted), Chat ID * |
| WeCom | Webhook URL * |
| Slack | Incoming Webhook URL * |

**Push routing**: determines which enabled channels actually receive alerts.

| Policy | Behavior |
| --- | --- |
| First enabled channel (default) | Legacy behavior: alerts go to the first enabled channel only |
| All enabled channels | Alerts are pushed to every enabled channel simultaneously |
| Per-level routing | warn / danger / recovery each select target channels; a level with no selection falls back to the first enabled channel; disabled channels are filtered out |

**Message template (per channel)**: when editing a channel you can set a message template with variables `{{level}}`, `{{message}}`, `{{time}}`, `{{channel}}`. Leave it empty to keep the default wording; unknown variables are kept as-is. All push paths (alerts, recovery, self-heal, approvals) render through the channel template.

**Container self-heal**: configure automatic recovery rules per container name (exact match, stable across container recreation).

| Field | Description |
| --- | --- |
| Container name * | e.g. `nginx-proxy` |
| Watch condition * | Healthcheck failed (unhealthy) / container exited or dead (exited/dead) |
| Recovery action * | restart / start |
| Cooldown * | Minimum interval between two triggers of the same rule, 10–86400 seconds (default 300) to prevent restart storms |
| Enable toggle | Disabled rules are skipped during checks |

The backend checks every 10 seconds; on a hit the action runs and a record is written to the alert history (type = self-heal): success pushes a recovery-level notice, failure pushes danger-level — both routed via push routing and rendered through channel templates. Use "Run check now" on the card to trigger a manual sweep.

**Resource alert rules (CPU / memory / disk / GPU / network)**: enable toggle, warn threshold % *, danger threshold % *, consecutive cycles (fire only after N consecutive sampling cycles over the threshold, default 1 = immediate), silence window, workdays only, work hours.

**Container alert rules**: target container *, monitor type * (exit / healthcheck / port / CPU / memory), probe port (port type), warn %, danger %, consecutive cycles (CPU / memory only), enable, silence window, workdays only, work hours.

**Debounce toolkit**: transient-spike filtering (consecutive cycles) → push aggregation → silence window / work hours → 30-minute repeat suppression for the same alert; combine as needed.

### 25.6 Firewall (`/firewall`)

| Field | Description | Required |
| --- | --- | --- |
| Port * | 1–65535, e.g. `8080` | Yes |
| Protocol | `TCP` / `UDP` | No |
| Comment (optional) | e.g. "Nginx external service" | No |

### 25.7 Scheduled Tasks (`/tasks`)

Common fields: task name *, task type *, cron expression * (5 fields: min hour day month weekday), enable toggle.

Task types and their parameters:
- **Prune**: scope (unused images / stopped containers / unused volumes / unused networks / build cache)
- **Backup**: target (panel database / named volumes), volume names (comma-separated, required for volumes), retention count
- **Pull**: image name * (e.g. `nginx:latest`)
- **Restart / Healthcheck**: target containers * (multi-select)
- **Command**: command *, working directory
- **Compose up / down**: Compose project *
- **Git auto-deploy**: deploy mode (build image / compose up), Git URL *, branch, image name / Compose project, private repo credentials (HTTPS token / SSH key)

### 25.8 Compose Project (`/compose`)

- New: project name * + `docker-compose.yml` (required; from template: blank / WordPress / Nginx static / Redis / PostgreSQL / Node.js; supports uploading `.yml` / `.yaml`)
- Edit: only `docker-compose.yml`
- Save as template: template name *, description
- Delete: optional "also delete this project's volumes"

### 25.9 App Store (`/appstore`)

Install-time configuration:
- **Environment variables**: fill each declared KEY / value (marked required when it has a default but no description)
- **Port mappings** (add/remove rows): container port, host port (optional), protocol (tcp / udp)
- **Volume mounts** (single container): source (host path or volume name), container path (e.g. `/data`), read-only
- **Image source**: default mirror or a specific enabled source (blank tries all in order)

### 25.10 Backup & Restore (`/backups`)

- Type: `Panel database` / `Volumes` / `Compose config` / `Site config`
- Name *, source (optional, e.g. a volume name)
- Upload to cloud requires a target configured under `/cloudbackup`

---

## 26. FAQ

| Issue | Resolution |
| --- | --- |
| "Cannot connect to Docker engine" | Make sure Docker Desktop is running; if needed set `DOCKER_HOST` to a reachable endpoint. |
| Image search fails (502 / unavailable) | Most mirror accelerators only proxy pulls, not Docker Hub search. In **Image Hub → Sources → Search source** enter a search-capable source (e.g. `https://docker-0.unsee.tech`, fallback `https://docker.tbap.top`). If still failing, use "Common images" or pull a known image name. |
| Forgot the admin password | Stop the service, delete `data/docker-manager.db` (plus `-wal` / `-shm` files), restart; defaults (`admin` / `admin888`) are re-initialized. |
| Backup / migrate data | Copy the whole `data/` directory (core file `docker-manager.db`). |
| Why does the login button read "登 录" | The button text is "登 录" (with a space) — normal. Enter credentials and click it to log in. |
| Cannot connect after Linux install | Ensure the `dockerman` user is in the docker group: `sudo usermod -aG docker dockerman`, then restart the service. |
| Cannot access after Windows install | Confirm Docker Desktop is running and the NSSM service is healthy (check `services.msc` for the DockerManager service). |
| Firewall blocks access | Linux: `firewall-cmd --permanent --add-port=9528/tcp && firewall-cmd --reload`; Windows: use the panel's **Firewall** page to allow the port. |

---

## 27. Image Vulnerability Scanning

| Item | Details |
| --- | --- |
| Path | Images → Image List → Vulnerability Scan |
| Access | All users |
| Backend dependency | Trivy (auto-detected; install prompt shown if missing) |

![Image vulnerability scanning](../images/vuln-scan.png)

### 27.1 Usage

1. Go to **Image Management** and select the target image;
2. Click the **Vulnerability Scan** button;
3. The system invokes Trivy to scan image layers and returns a CVE vulnerability list.

### 27.2 Result Interpretation

| Field | Meaning |
| --- | --- |
| CVE ID | Vulnerability identifier |
| Severity | Critical / High / Medium / Low / Unknown |
| Installed Version | Package version found in the image |
| Fixed Version | Available fix version (if any) |
| Title | Vulnerability description |

### 27.3 Recommendations

- **Critical / High** vulnerabilities should be addressed by updating the base image or upgrading dependencies;
- Click **Rescan** to verify the fix;
- Use the **Image Build** feature to rebuild with an updated base image.

---

## 28. Cross-Engine Container Migration / Image Transfer

| Item | Details |
| --- | --- |
| Path | Docker Engines → Engine Details → Migrate / Transfer |
| Access | Admin 🔒 |

![Cross-engine migration](../images/cross-engine-migration.png)

### 28.1 Overview

Migrate containers or images from one Docker engine to another. Use cases:
- Data migration when replacing a host;
- Load balancing across engines;
- Environment replication (production → staging).

### 28.2 Steps

1. Go to **Docker Engines** and select the source engine;
2. Select the container or image to migrate;
3. Select the target engine;
4. Click **Migrate / Transfer**;
5. The system uses `docker save` + `docker load` to complete the transfer.

### 28.3 Notes

- Large images take longer to transfer; ensure stable network connectivity;
- Containers must be stopped before migration;
- Transfer runs server-side; closing the browser does not interrupt it.

---

## 29. Cross-Engine Aggregated Overview

| Item | Details |
| --- | --- |
| Path | Overview → Multi-Engine Aggregation |
| Access | Admin 🔒 |

![Cross-engine aggregated overview](../images/cross-engine-overview.png)

### 29.1 Overview

When multiple Docker engines are connected, the aggregated overview provides a unified view:
- Summarized container counts (running / stopped / paused) across all engines;
- Aggregated resource usage (CPU / Memory / Disk);
- Quick identification of unhealthy engines.

### 29.2 Page Elements

| Area | Content |
| --- | --- |
| Engine Cards | One card per engine showing name, status, container count, resource usage |
| Summary Metrics | Total containers, aggregate CPU usage, aggregate memory usage across all engines |
| Engine Switch | Click a card to navigate to that engine's detailed management page |

---

## 30. Global Search

| Item | Details |
| --- | --- |
| Location | Top navigation bar search box |
| Access | All users |

![Global search](../images/global-search.png)

### 30.1 Overview

Global search allows quick lookup across all resources without browsing individual pages.

### 30.2 Search Scope

| Resource Type | Search Fields |
| --- | --- |
| Containers | Name, ID, image name, status |
| Images | Name, tag, ID |
| Volumes | Name, driver |
| Networks | Name, driver |
| Compose Projects | Project name, path |
| Host Files | File name, path |

### 30.3 Usage

1. Click the search box in the top navigation bar (or press `/` shortcut);
2. Type keywords;
3. Dropdown shows matching results in real time;
4. Click a result to navigate directly to the corresponding page.

---

## 31. Container Resource Dashboard

| Item | Details |
| --- | --- |
| Path | Overview → Resource Dashboard |
| Access | All users |

![Container resource dashboard](../images/resource-dashboard.png)

### 31.1 Overview

Displays real-time resource usage rankings for all running containers, helping identify the most resource-consuming containers.

### 31.2 Dashboard Content

| Metric | Description |
| --- | --- |
| Top CPU | Containers sorted by CPU usage (descending) |
| Top Memory | Containers sorted by memory usage (descending) |
| Network I/O | Network send/receive traffic per container |
| Disk I/O | Disk read/write volume per container |

### 31.3 Operations

- Click a container name to navigate to its detail page;
- Filter by engine;
- Data auto-refreshes every 5 seconds.

---

## 32. Monitoring History

| Item | Details |
| --- | --- |
| Path | Overview → Monitoring History |
| Access | All users |

![Monitoring history](../images/monitoring-history.png)

### 32.1 Overview

The system automatically persists monitoring data, supporting different time ranges:
- **1 Hour**: 5-second granularity, for instant anomaly investigation;
- **24 Hours**: 1-minute granularity, for daily inspection;
- **7 Days**: 5-minute granularity, for trend analysis.

### 32.2 Charts

| Chart | Content |
| --- | --- |
| CPU Usage | CPU usage trend per engine/container |
| Memory Usage | Memory usage trend per engine/container |
| Network Traffic | Network send/receive trend per engine/container |
| Disk I/O | Disk read/write trend per engine/container |

### 32.3 Data Management

- Monitoring data is stored in the SQLite database;
- Default retention is 30 days; configurable in **System Settings → Monitoring**;
- CSV export of historical data is supported.

---

## 33. Template / Image Hub Enhancements

| Item | Details |
| --- | --- |
| Path | Image Hub / Container Templates |
| Access | All users |

![Template & image hub enhancements](../images/hub-enhanced.png)

### 33.1 Image Hub Enhancements

| Feature | Description |
| --- | --- |
| Batch cleanup by category | Clean unused images in bulk by category (e.g. `library`, `bitnami`) |
| Port conflict detection | Automatically check for port conflicts before creating a container |
| Vulnerability scan entry | Launch vulnerability scan directly from the image list (see Chapter 27) |
| Build history | View history of images built through the panel |

### 33.2 Template Library Enhancements

| Feature | Description |
| --- | --- |
| Compose template library | Pre-built Compose templates for common apps (WordPress, MySQL, Redis, etc.) |
| One-click deploy | Select a template and deploy a Compose project with one click |
| Template favorites | Bookmark frequently used templates for quick access |
| Custom templates | Save existing Compose configurations as custom templates |

---

## 34. Configuration Import / Export

| Item | Details |
| --- | --- |
| Path | System Settings → Configuration Management |
| Access | Admin 🔒 |

![Configuration import/export](../images/config-import-export.png)

### 34.1 Overview

Export panel configuration to a JSON file, or import from a JSON file. Use cases:
- Syncing configuration across multiple instances;
- Restoring configuration after reinstallation;
- Environment migration.

### 34.2 Export Configuration

1. Go to **System Settings → Configuration Management**;
2. Select configuration items to export (multiple selection supported);
3. Click **Export**;
4. Browser downloads a JSON file.

### 34.3 Exportable Configuration Items

| Item | Content |
| --- | --- |
| Engine Configuration | Docker engine connection information |
| Template Configuration | Container templates and Compose templates |
| Scheduled Tasks | All cron task configurations |
| Site Configuration | Reverse proxy and port mapping configurations |
| Notification Configuration | Alert rules and notification channels |
| System Settings | Panel global settings |

### 34.4 Import Configuration

1. Go to **System Settings → Configuration Management**;
2. Click **Import** and select a JSON file;
3. Preview the configuration items to be imported;
4. Confirm the import.

> **Note**: Import overwrites existing configurations with the same name. It is recommended to export the current configuration as a backup first.

---

## 35. Webhook / Git Auto Deployment

| Item | Details |
| --- | --- |
| Path | Scheduled Tasks → New Task → Webhook / Git Deploy |
| Access | All users |

![Webhook & Git auto deployment](../images/webhook-git-deploy.png)

### 35.1 Webhook Trigger

Trigger container operations via HTTP requests:

| Parameter | Description |
| --- | --- |
| Task Type | Select "Webhook Trigger" |
| Target Container | Select the container to operate |
| Operation | Start / Stop / Restart |
| Token | Auto-generated authentication token, required in the request |

Trigger endpoint: `POST /api/webhook/{taskId}?token={token}`

### 35.2 Git Auto Deployment

Automated Git repository pull and deployment:

| Parameter | Description |
| --- | --- |
| Task Type | Select "Git Deploy" |
| Repository URL | Git repository URL |
| Branch | Target branch (default: main) |
| Deploy Path | Local clone path |
| Deploy Command | Command to run after clone/pull (e.g. `docker compose up -d`) |

### 35.3 Execution Modes

| Mode | Description |
| --- | --- |
| Scheduled | Pull and deploy on a cron schedule |
| Webhook Trigger | Trigger deployment after code push via webhook |
| Manual | Click "Run Now" in the task list |

---

## 36. Ops Toolbox

Menu: **Tools** (`/tools`, all users)

- Common utilities as a pure-frontend toolbox: JSON format / validation, regex testing, Base64, timestamp conversion, radix conversion, port & CIDR calculators, etc.
- Zero backend calls; handy for day-to-day ops.

![Ops Toolbox](../images/tools.png)

---

## 37. Port Map

Menu: **Ports** (`/ports`, all users)

- Cross-engine aggregation of **port usage**: which host ports are bound by which containers.
- **Conflict detection** for duplicated bindings and a visual port distribution map.

![Port Map](../images/ports.png)

---

## 38. Prometheus / Grafana Integration

- Built-in **`/metrics` endpoint** exposing Prometheus text-format metrics (optional Token auth via the `metrics.token` system parameter).
- One-click export of a prebuilt **Grafana Dashboard JSON** for direct import.

---

## 39. Security Baseline Scanning 🔒

Menu: **Security Baseline** (`/policy`, admin only)
API: `GET /api/policy/scan` (read-only scan); `POST /api/policy/fix` (online fix)

Six built-in baseline rules, checked read-only against all running containers:

| Rule | Level | Online fix |
| --- | --- | --- |
| Privileged containers (--privileged) | Danger | ❌ Recreate required |
| Sensitive mounts (docker.sock etc.) | Danger | ❌ Recreate required |
| No memory limit | Advice | ✅ Default 512MB (params.memoryBytes) |
| No CPU limit | Advice | ✅ Default 1 core (params.cpus) |
| Restart policy no / none | Advice | ✅ Default unless-stopped (params.policy) |
| Missing owner label | Info | ❌ Recreate required |

**One-click fix**: memory / CPU / restart-policy violations support online fixes via the Docker Container Update API, with automatic re-scan afterwards. Privileged mode, sensitive mounts and owner labels require container recreation — the page shows hardening advice instead. Fixes go through the approval gate (`container.fix`): when the approval flow is enabled, fixes submitted by non-admins become approval requests.

![Security baseline scanning](../images/policy.png)

---

## 40. High-Risk Operation Approval Flow

| Project | Description |
| --- | --- |
| Path | `/approvals` |
| Permission | All users (regular users only see their own requests) |
| Switch | Settings → System Parameters → Security → "High-risk operation approval flow" (off by default) |

When enabled:

1. **Non-admin** users performing container deletion (incl. batch), volume deletion, image deletion (incl. batch), image prune, volume prune, network prune, or Compose project shutdown no longer take effect directly — the action enters the **Approval Center** as pending (HTTP 202).
2. **Admins** approve in the Approval Center and the system executes; rejection requires a mandatory reason and is fully audited.
3. Regular users may also **proactively submit** requests (image delete, volume delete, network prune, etc.); batch container deletion creates one approval record per target.
4. Admins — and roles granted the corresponding permission in Role management (e.g. "Delete container", "Prune volumes") — are never gated.
5. Duplicate pending requests for the same target by the same user are merged automatically.
6. Approval targets resolve to human-readable names (falling back to short IDs after deletion).
7. **Batch processing**: admins can multi-select pending records and batch approve / reject (up to 50 per batch, rejection reason required, executed sequentially — one failure does not affect the rest).
8. **AI action gating**: AI-suggested container/image deletions automatically become approval requests when the flow is enabled and the executor is a non-admin (AI actions enter "pending admin approval"; results are written back to the AI action record after execution).

**When the approval flow is off**: delete / prune endpoints return 403 for non-admins (admin-only as before); custom roles (RBAC) holding the corresponding permission always execute directly and bypass approvals.

**Gated actions**: container delete (`container.delete`), image delete (`image.delete`), batch image delete (`image.deleteBatch`), dangling image prune (`image.prune`), volume delete (`volume.delete`), volume prune (`volume.prune`), network prune (`network.prune`), compose project down (`compose.down`), container config fix (`container.fix`).

**Approval stats**: admins also see the "Approval Stats" card (last 30 days) with an executed OK / failed overview, a per-action distribution table (total / approved / rejected / pending) and a top-submitter list, giving an at-a-glance view of dangerous operations.

**CSV export**: the toolbar "Export CSV" button downloads approval records as CSV (UTF-8 BOM, Excel-friendly), following the current status filter. Admins export all records; other users export only their own (no 200-record list cap).

![Approval center](../images/approvals.png)

---

## 41. AI Assistant

| Project | Description |
| --- | --- |
| Path | `/assistant` |
| Permission | All users (model config admin only 🔒) |
| Prerequisite | Add any OpenAI-compatible endpoint in Settings → AI Config Center |

- **Multi-model config center**: one-click presets for local (Ollama / LM Studio / Docker Model Runner) and cloud (OpenAI / DeepSeek / Kimi, etc.) endpoints; multiple profiles with encrypted keys.
- **AI capabilities**: chat Q&A, file analysis (Dockerfile / Compose / logs), smart inspection, alert diagnosis, weekly reports, knowledge base, token usage governance.
- **Automatic alert AI diagnosis**: after a danger-level alert is pushed successfully, AI analyzes the root cause and pushes the diagnosis to the same channel; controlled by the `alerts.aiDiagnosis` parameter (on by default). Alerts that were aggregated by the push window do not trigger AI diagnosis.
- **Safety boundary**: AI only suggests; it never executes directly. Without an AI configuration all AI entries hide automatically.

![AI Assistant](../images/assistant.png)

---

## 42. Help Center

| Project | Description |
| --- | --- |
| Path | `/help` |
| Permission | All users |

Three built-in blocks: **Quick Start** (six-step guide), **FAQ** (password reset, remote engines, approval flow, AI setup, etc.), and a **feature index** of all pages.

![Help Center](../images/help.png)

---

## 43. Kubernetes Read-only Inspection

> Read-only inspection added in 1.5.0; limited write operations since 1.6.0. For teams that also maintain Kubernetes clusters: inspect clusters and perform scaling / restarts / pod deletion without touching Docker management features.

| Project | Description |
| --- | --- |
| Path | `/k8s` (Cluster Overview), `/k8s/workloads` (Workloads), `/k8s/pod/:ns/:name` (Pod detail), `/k8s/events` (Cluster Events) |
| Permission | All users |

### 43.1 Connecting a Cluster

The panel loads cluster credentials in the following order — no passwords are entered in the UI:

1. The kubeconfig file pointed to by the `KUBECONFIG` environment variable;
2. `~/.kube/config` of the user running the panel;
3. InCluster config, applied automatically when the panel itself is deployed as a Pod.

If the kubeconfig contains multiple contexts (multiple clusters), switch them at any time from the dropdown at the top of the Cluster Overview page; switching only affects the current panel process and is never written back to the kubeconfig file.

> When no kubeconfig can be detected and the panel is not running inside a cluster, K8s pages show setup guidance instead of errors; Docker-domain features remain unaffected.

### 43.2 Cluster Overview (/k8s)

- Stat cards: nodes / pods / services / PVCs;
- Node table: name, role (control-plane / worker), Ready status, CPU and memory usage bars, kubelet version, internal IP;
- Usage data comes from metrics-server; if it is not installed, the column degrades to "—" with a hint;
- **Node resource trend** (1.9.0): node snapshots are sampled every 60s into hourly rollups retained for 90 days, viewable as cluster CPU / memory totals over 1d / 7d / 30d / 90d windows;
- **Node detail page** (1.11.0): click a node name to open `/k8s/node/:name` with node metadata and a per-node trend chart.

![Node detail](../images/k8s-node-detail.png)

![K8s Cluster Overview](../images/k8s-overview.png)

### 43.3 Workloads (/k8s/workloads)

Tabs: **Pod / Deployment / Service / PVC / ConfigMap / Ingress / Helm**, all supporting namespace filtering and keyword search. The "Helm" tab shows release name / namespace / revision / status / last deploy time (1.13.0). Secrets are listed under the ConfigMap tab with **values masked** (keys and type only, 1.8.0).

- The Pod list shows status (including container-level reasons such as CrashLoopBackOff), ready containers, restarts and node; click any row for details;
- Deployments show desired / ready replicas; services show type, ClusterIP and ports; PVCs show Bound status, capacity and StorageClass.

![Workloads](../images/k8s-workloads.png)

### 43.4 Pod Detail (/k8s/pod/:ns/:name)

- Basics: namespace, status, readiness, restarts, node, creation time;
- Containers: Ready flag, image and restarts per container;
- Logs: switchable per container when multiple exist, last 500 lines by default (max 2000), manual refresh;
- Resource charts: CPU (millicores) and memory (KiB), sampled every 15 seconds while the page stays open (in-memory only, not persisted);
- Related events: Warning / Normal events attached to this pod;
- **Pod Terminal** (1.7.0, admin visible): the "Open Terminal" button starts an interactive shell via `/ws/k8sterminal/:ns/:pod/:container` (xterm.js + WebSocket exec); with multiple containers the first one is used by default.

### 43.5 Write Operations (1.6.0)

| Endpoint | Description |
| --- | --- |
| Scale | Adjust Deployment replicas (0-500) — admin, or roles with `k8s.write` |
| Rolling restart | Trigger a rolling update — admin, or roles with `k8s.write` |
| Delete Pod | Delete a pod (Deployment-managed pods are recreated) — admin, or roles with `k8s.delete` |

When the high-risk approval flow is enabled, operations without direct permission are routed to the Approval Center with an AP- ticket; scale/restart/delete can be configured as two-level approval in system parameters. Frontend entry points (admin visible): Scale / Rolling Restart buttons on Deployment rows in Workloads, and the Delete Pod button on the Pod detail page.

### 43.6 Cluster Events (/k8s/events)

Filter cluster events by namespace, level (Warning / Normal) and keyword, showing object, reason, message, count and last-seen time — useful alongside workload inspection for troubleshooting. Since 1.10.0 a "Live" toggle streams new events over WebSocket in real time (backend auto-reconnects).

![K8s Cluster Events](../images/k8s-events.png)

---

## Appendix: Modules & Routes

| Menu | Route | Access |
| --- | --- | --- |
| Overview | `/` | All users |
| Health Check | `/health` | All users |
| Containers | `/containers` | All users |
| Container Templates | `/templates` | Admin 🔒 |
| Orchestrate | `/orchestrate` | Admin 🔒 |
| Images | `/images` | All users |
| Image Build | `/build` | Admin 🔒 |
| Volumes | `/volumes` | All users |
| Storage | `/storage` | All users |
| Networks | `/networks` | All users |
| Compose | `/compose` | All users |
| App Store | `/appstore` | All users |
| Scheduled Tasks | `/tasks` | All users |
| Files | `/files` | All users |
| Host Files | `/hostfiles` | All users |
| Host Terminal | `/hostterminal` | All users |
| Docker Engines | `/engines` | Admin 🔒 |
| Cloud Backup | `/cloudbackup` | Admin 🔒 |
| Swarm | `/swarm` | Admin 🔒 |
| Backup & Restore | `/backups` | All users |
| Databases | `/databases` | All users |
| Settings | `/settings` | All users |
| Image Hub | `/hub` | All users |
| Operation Logs | `/operation-logs` | All users |
| Notifications | `/notifications` | Admin 🔒 |
| Event Stream | `/events` | All users |
| Sites (proxy / port mapping) | `/sites` | Admin 🔒 |
| Firewall | `/firewall` | Admin 🔒 |
| Image Vulnerability Scan | `/images` → Scan | All users |
| Cross-Engine Migration | `/engines` → Engine Details | Admin 🔒 |
| Cross-Engine Aggregated Overview | Auto-displayed in multi-engine mode | Admin 🔒 |
| Global Search | Top navigation bar search box | All users |
| Resource Dashboard | Bottom of Overview page | All users |
| Monitoring History | Overview → Monitoring History | All users |
| Image Hub Enhancements | `/hub` | All users |
| Config Import/Export | `/settings` → Config Management | Admin 🔒 |
| Webhook / Git Deploy | `/tasks` → New Task | All users |
| Ops Toolbox | `/tools` | All users |
| Port Map | `/ports` | All users |
| Security Baseline | `/policy` | Admin 🔒 |
| Approval Center | `/approvals` | All users |
| Panel Database Backup | `/settings` → Panel Database Backup Management | Admin 🔒 |
| AI Assistant | `/assistant` | All users (config admin only 🔒) |
| Prometheus Metrics | `/metrics` | Optional Token auth |
| Help Center | `/help` | All users |
| K8s Cluster | `/k8s` | All users |
| Workloads | `/k8s/workloads` | All users |
| K8s Events | `/k8s/events` | All users |

> This document reflects the current version; the installed version may differ. Administrator-only (🔒) pages are hidden from regular users in both menu and routes.
