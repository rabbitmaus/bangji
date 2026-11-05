# bangji

범용 스크리닝 기반 업무 자동화 앱. 수집처에서 항목을 모아 내 기준으로 선별하고, 근거를 검토한 뒤 사실에 연결된 작업물을 만든다(현재 대표 시나리오: 채용 공고 → 맞춤 이력서). 구성: `web`(Node/TypeScript, 8080), `evaluator`(Python, 8000), `apphost`(Aspire AppHost). 자세한 설계는 `PRD.md`, `TRD.md`를 본다.

## 사전 준비

- Node.js 22+, Python 3.12+(evaluator), Docker
- [Aspire CLI](https://aspire.dev) 13.6+ 와 .NET 10 SDK (file-based AppHost `apphost/apphost.cs`를 빌드한다)
- Azure CLI(`az`) — 배포와 로컬 Azure 접근용

## 로컬 실행

```bash
# 전체(web + evaluator, Azure 리소스는 배포 때만 생성): Aspire 대시보드와 함께 실행
aspire run --apphost apphost/apphost.cs

# web만 개발 서버로
cd web && npm install && npm run dev

# 모델 호출 없이 가짜 모델로 실행
BANGJI_FAKE_MODEL=1 npm run dev     # web 디렉터리에서
```

로컬에서 Azure 데이터 저장소를 쓸 때는 `az login` 자격 증명(`DefaultAzureCredential`)을 쓴다. 키는 쓰지 않는다.

### 사용자 지정 URL과 Browserbase

사용자가 입력한 임의 URL은 로컬 headless Chromium에서 403으로 막히는 사이트가 많다. 환경 변수 `BROWSERBASE_API_KEY`가 있으면 데모 보드를 제외한 **사용자 지정 URL(화면 선택·미리보기·수집)이 Browserbase 원격 브라우저(Stagehand v4)** 로 열린다(프로젝트는 키에서 추정). 키가 없으면 지금처럼 로컬 Chromium을 쓰고, 403/429로 막히면 `page_blocked` 오류로 키 설정을 안내한다. 데모 보드는 `127.0.0.1`이라 항상 로컬 Chromium을 쓴다. `/health`의 `browser` 값(`browserbase`|`local`)으로 확인한다.

```bash
# web/.env.local 에 BROWSERBASE_API_KEY=... 저장 (git에 올라가지 않음, web/.env.example 참고)
```

배포 시에는 선택 시크릿 파라미터 `browserbase-api-key`(`Parameters__browserbase_api_key=...`)로 전달하면 web에 `BROWSERBASE_API_KEY`로 주입된다. 값이 없으면 파라미터를 선언하지 않으므로 배포가 막히지 않는다.

## 배포 (Azure Container Apps)

```bash
az login
aspire deploy --apphost apphost/apphost.cs
```

처음 실행하면 구독, 리소스 그룹, 지역(Korea Central 권장)과 secret 파라미터 `copilot-github-token`, `guest-cookie-secret`(32바이트 이상 임의 값), 모델 파라미터를 묻는다. 같은 명령으로 다시 배포한다.

| 옵션 | 설명 |
| --- | --- |
| `--apphost <path>` | AppHost 파일 또는 검색할 디렉터리 |
| `-e, --environment <name>` | 환경 이름(기본 `Production`) |
| `--list-steps` | 파이프라인 단계만 나열하고 실행하지 않음 |
| `--non-interactive` | 프롬프트 없이 실행(파라미터는 환경 변수/설정으로 미리 제공) |
| `--clear-cache` | 저장된 배포 상태 캐시 삭제 |

```bash
# 단계 확인
aspire deploy --list-steps --apphost apphost/apphost.cs

# 비대화형 배포 예 (파라미터는 Parameters__<name> 환경 변수로 전달, 하이픈은 밑줄로)
Parameters__copilot_github_token=... Parameters__guest_cookie_secret=... \
  aspire deploy --apphost apphost/apphost.cs --environment Production --non-interactive
```

배포 후 `https://web.<고유 ID>.<지역>.azurecontainerapps.io/health`가 200을 돌려주는지 확인한다.

### 프로비저닝되는 리소스

Container Apps 환경 + Container Registry, Cosmos DB(serverless, 키 인증 끔, `bangji/workspace-data`, 파티션 `/workspaceId`, TTL 7일), Storage(공유 키 끔, `artifacts` 컨테이너, `ws/` blob 7일 후 삭제), Log Analytics + Application Insights. `web`(외부 ingress, 2 vCPU/4 GiB, 복제본 1)은 Cosmos Built-in Data Contributor와 Storage Blob Data Contributor를 받고, `evaluator`(내부 ingress, 1 vCPU/2 GiB, 복제본 1)는 데이터 권한이 없다.


## Workflow 스튜디오

홈 상단 `Workflow 스튜디오`에서 제한된 타입 DAG를 만든다. `jobsToResume` 템플릿으로 시작해 단계 목록(또는 캔버스)에서 이름을 고치고 `노드 추가`로 카탈로그 노드(예: `mergeDedupe`)를 넣는다. 검증 오류는 배너로 보인다. `AI 변경안`은 diff를 제안하며 `적용`·`거절`로 결정한다. `샘플 실행`으로 노드별 상태·입출력·예산을 확인한 뒤 `승인`하고 `실행`한다. 임의 코드·루프·외부 제출 노드는 허용되지 않는다.

### 환경 변수

| 이름 | 설명 |
| --- | --- |
| `LIMIT_PREP_PER_HOUR` | 게스트당 시간당 수집 준비 한도 |
| `LIMIT_ASSISTANT_PER_HOUR` | 게스트당 시간당 AI 변경안·도우미 호출 한도 |
| `BROWSERBASE_API_KEY` | 선택. 설정하면 사용자 지정 URL을 Browserbase로 연다(페이지 데이터가 외부 사업자로 전송됨). 기본은 꺼짐 |

## 측정과 스모크

```bash
# 서버를 띄운 뒤(예: BANGJI_FAKE_MODEL=1 npm run dev) PRD 3.1 시나리오 측정. 실행 결과만 값이 된다
BASE_URL=http://127.0.0.1:8080 node web/scripts/measure.mjs   # docs/measurements/<날짜>.json 생성
# 실제 모델 스모크
python evaluator/scripts/smoke_models.py
```

M1·M2·M7은 사람이 재며 절차는 `docs/measurement-protocol.md`에 있다. 측정 전까지 PRD 지표는 `미측정`이다.

## 배포 검증 체크리스트

- [ ] `/health`가 200이고 `web`·`evaluator` 상태 정상
- [ ] Cosmos DB 읽기·쓰기(RW) 확인: 게스트 생성 후 계약 저장이 성공
- [ ] Blob 쓰기·읽기 확인: 스크린샷 또는 내보내기 산출물
- [ ] 실행 하나를 돌려 Application Insights에서 트레이스 ID로 span 확인
