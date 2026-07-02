# 배포 이력 — 레퍼런스 인스턴스

> 범용 배포 절차는 [deploy.md](deploy.md) 참고. 이 문서는 원 저자 인스턴스의 기록이다.

## 현재 상태 (2026-07-03)

| 리소스 | 값/상태 |
|---|---|
| Worker | ✅ https://<worker-host> (custom domain; workers.dev 라우트는 자동 비활성화됨) |
| 계정 | YP (`<cloudflare-account-id>`) |
| D1 `flaregraph` | ✅ `<d1-database-id>`, 마이그레이션 `0000_init` 적용 |
| R2 `flaregraph-vault` | ✅ 생성 (2026-07-02T22:01Z) |
| R2 이벤트 알림 | ✅ rule `<r2-notification-rule-prefix>…` — Put/Copy/Multipart/Delete/Lifecycle → `flaregraph-index` |
| Queues | ✅ `flaregraph-index` (`<queue-id-prefix>…`), DLQ `flaregraph-index-dlq` |
| Vectorize `flaregraph-chunks` | ✅ 1024 dims, cosine |
| Workers AI | ✅ `@cf/baai/bge-m3` 임베딩 동작 확인 (1024-dim) |
| Secrets | ✅ `API_TOKEN` 설정됨 / ⬜ `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` 미설정 |
| Cloudflare Access (이메일 로그인) | ⬜ 미설정 — deploy.md 6번 절차 |
| remotely-save 동기화 | ⬜ 미설정 — deploy.md 7번 절차 |

## 타임라인

### 2026-07-02 (1차 — R2 없이 부분 배포)

- 모노레포 전체 구현 후 리소스 프로비저닝: D1 생성 + 원격 마이그레이션, Queues 2개,
  Vectorize 인덱스 생성.
- **R2 활성화 안 됨(code 10042)** + wrangler OAuth 토큰에 `r2`/`access` 스코프 부재
  → R2 바인딩을 뺀 `wrangler.no-r2.jsonc`로 우선 배포. R2 필요 경로는 안내 에러를
  반환하도록 가드(Proxy) 추가.
- `API_TOKEN` 시크릿 설정, 배포 검증: 무인증 401, Bearer 인증 OK, MCP `tools/list` OK.
- 로컬(wrangler dev)에서 capture → R2 → Queue → 인덱싱 → 한국어 FTS 검색 E2E 확인.

### 2026-07-02~03 (2차 — 풀 배포)

- 사용자가 대시보드에서 R2 활성화 + `flaregraph-vault` 버킷 및 이벤트 알림 rule 생성.
- `wrangler.jsonc`(R2 바인딩 포함) 풀 구성으로 재배포. 임시 `wrangler.no-r2.jsonc` 제거.
- 프로덕션 E2E 검증:
  - `POST /api/capture` → R2 `inbox/` 파일 생성 ✅
  - R2 이벤트 → Queue → 인덱서 → D1 (약 20초 내) ✅
  - 한국어 FTS 검색(`한국어 색인` → snippet 매칭) ✅
  - 시맨틱 검색(BGE-M3 + Vectorize, `mode=semantic`) ✅
  - R2 오브젝트 삭제 → 삭제 이벤트 → soft-delete 반영 ✅
- 스모크 테스트 노트는 검증 후 삭제함.

### 2026-07-03 (커스텀 도메인)

- `<worker-host>`를 Workers custom domain으로 연결 (`wrangler.jsonc`의 `routes`,
  DNS/인증서 자동 발급). 이후 workers.dev 라우트는 자동 비활성화(404).

### 2026-07-03 (콘솔 UI)

- QuietFabric 디자인 시스템 기반 콘솔 UI를 `apps/worker/console/`에 추가하고
  Workers Static Assets로 서빙 (`assets.run_worker_first: ["/api/*", "/mcp"]`).
- 정적 UI는 공개(데이터 없음), API/MCP는 계속 인증 게이트. 401 시 UI가 토큰
  입력 다이얼로그를 띄우고 localStorage에 보관. Access를 붙이면 쿠키로 자동 인증.
- 기존 인라인 `src/ui.ts` 제거.

## 운영 메모

- 토큰 분실 시 재발급: `openssl rand -hex 32 | wrangler secret put API_TOKEN` (apps/worker에서).
- 풀 리인덱스: `POST /api/index/rebuild` — R2 미러 기준 전체 재색인 (D1/Vectorize 유실 복구용).
- 에러 북: `GET /api/errors`, 증류 규칙: `GET /api/rules`.
- 정합성 검증: `flaregraph verify ~/Vault --api https://<worker-host>`
  (`CF_ACCESS_CLIENT_ID/SECRET` 또는 Bearer 환경변수 필요).
