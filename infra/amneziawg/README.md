# AmneziaWG: сервер ↔ домашний ПК с телефонной фермой (ADB)

Точка-точка туннель между сервером (где крутится `orchestrator`) и домашним
ПК (где стойка плат и `apps/device-agent`). Роутится **только** этот линк —
не полный VPN, не проксирование интернета домашнего ПК через сервер.
`device-agent` слушает исключительно на туннельном IP, поэтому управление платами
никогда не торчит наружу напрямую.

Подсеть туннеля (пример, можно менять): `10.13.13.0/24`
- сервер: `10.13.13.1`
- домашний ПК: `10.13.13.2`

## 1. Сервер (Linux, где живёт docker-compose)

AmneziaWG требует ядерный модуль/DKMS — гонять его **внутри Docker
контейнера бессмысленно** (нужен доступ к сетевому стеку хоста), ставим на
хост сервера напрямую:

```bash
# Ubuntu/Debian — официальный установщик
curl -fsSL https://raw.githubusercontent.com/wiresock/amneziawg-install/main/amneziawg-install.sh -o awg-install.sh
sudo bash awg-install.sh
# скрипт задаст вопросы (порт, DNS) и попросит один-два ребута DKMS-модуля —
# после каждого ребута перезапустить ту же команду, она продолжит с места
```

После установки конфиг сервера лежит в `/etc/amnezia/amneziawg/awg0.conf`.
Возьмите `server.conf.example` из этой папки как шаблон **структуры** — но
секцию `[Interface]` (Jc/Jmin/Jmax/S1/S2/H1-H4, PrivateKey) **обязательно
сгенерируйте установщиком**, не копируйте примерные числа из этого репо:
эти параметры — часть обфускации, если у всех одинаковые — DPI их
отфингерпринтит.

Добавьте пир (домашний ПК) в `awg0.conf`:

```ini
[Peer]
PublicKey = <публичный ключ домашнего ПК>
AllowedIPs = 10.66.66.2/32
```

Для того чтобы Docker-контейнеры (`api`, `orchestrator`) могли беспрепятственно опрашивать домашний ПК через туннель, в конфиге сервера `/etc/amnezia/amneziawg/awg0.conf` в секции `[Interface]` должны присутствовать правила трансляции:
```ini
PostUp = iptables -I FORWARD -o awg0 -j ACCEPT
PostUp = iptables -I FORWARD -i awg0 -j ACCEPT
PostUp = iptables -t nat -A POSTROUTING -o awg0 -j MASQUERADE
PostDown = iptables -D FORWARD -o awg0 -j ACCEPT
PostDown = iptables -D FORWARD -i awg0 -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o awg0 -j MASQUERADE
```
*(Или запустите готовый скрипт: `sudo bash infra/amneziawg/setup-server-routing.sh`)*.

Примените:
```bash
sudo systemctl restart awg-quick@awg0
sudo systemctl enable awg-quick@awg0
sudo ufw allow <ваш WG порт>/udp   # если ufw активен
```

## 2. Домашний ПК (Windows, где стойка телефонов)

1. Скачайте официальный клиент:
   https://github.com/amnezia-vpn/amneziawg-windows-client/releases
2. Сгенерируйте пару ключей в клиенте (или `awg genkey`/`awg pubkey`),
   пришлите публичный ключ на сервер для `[Peer]` выше.
3. Импортируйте конфиг:
   - `Address = 10.66.66.2/32`
   - `Endpoint = <публичный IP сервера>:<порт>`
   - `PublicKey` сервера и те же Jc/Jmin/Jmax/S1/S2/H1-H4.
4. `AllowedIPs = 10.66.66.1/32` — домашний ПК видит через туннель только
   сервер, никакого полного VPN.
5. Нажмите Connect. Проверка: `ping 10.66.66.1` с домашнего ПК,
   `ping 10.66.66.2` с сервера.

## 3. Дальше

- `apps/device-agent` на домашнем ПК слушает `10.66.66.2:8300` (запускается через `apps/device-agent/start-farm.bat`).
- Брандмауэр Windows: `start-farm.bat` автоматически открывает входящий порт 8300.
- В `.env` сервера: `DEVICE_AGENT_URL=http://10.66.66.2:8300`.
- Проверка доступности с сервера:
  `curl http://10.66.66.2:8300/devices`
