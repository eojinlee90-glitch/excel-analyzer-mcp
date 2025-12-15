const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

// --- 로그 유틸리티 ---
function logToFile(message) {
    const logPath = path.join(__dirname, 'server.log');
    const timestamp = new Date().toLocaleString();
    try {
        fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
    } catch (err) {}
}

function logToConsole(message) {
    console.error(`[DEBUG] ${message}`);
}

const server = new McpServer({
  name: "robot_data_extractor",
  version: "1.0.0"
});

function parseDate(val) {
    if (!val) return null;
    if (typeof val === 'number') {
        return new Date(Math.round((val - 25569) * 86400 * 1000));
    }
    const date = new Date(val);
    return isNaN(date.getTime()) ? null : date;
}

function isValidDateFormat(dateStr) {
    if (!dateStr) return false;

    // YYYY-MM-DD HH:MI:SS 형식 검증 (정규식)
    const regex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (!regex.test(dateStr)) return false;

    // 실제 날짜로 파싱 가능한지 확인
    const date = new Date(dateStr);
    return !isNaN(date.getTime());
}

function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const hour = Math.floor(min / 60);
    const minRemain = min % 60;

    if (hour > 0) {
        return `${hour}시간 ${minRemain}분 ${sec}초`;
    }
    return `${minRemain}분 ${sec}초`;
}

// =======================================================================
// [설정] 상태값 매핑 테이블
// =======================================================================
const DRIVE_MAP = {
    0: "대기(Stop)",
    1: "주행중(Run)",
    2: "주행 완료",
    3: "주행 취소",
    4: "장애물 감지 (경로 변경)",
    5: "주행 실패",
    6: "플랫폼 요청에 의한 정지",
    8: "UI 정지",
    9: "비상버튼 정지",
    12: "주행 불가",
    13: "플랫폼 정지 해제",
    14: "수동 주행",
    15: "맵 전환",
    16: "줄서기"
};

const CHARGE_MAP = {
    "false": "미충전",
    "true": "충전중"
};

// 값을 텍스트로
function getDriveText(code) {
    return DRIVE_MAP[code] || `알수없음(${code})`;
}
function getChargeText(code) {
    const key = String(code).toLowerCase();
    return CHARGE_MAP[key] || `알수없음(${code})`;
}
// =======================================================================

server.tool(
  "fetch_robot_events",
  "로봇 주행 로그(엑셀)를 분석하여 주행 및 충전 상태가 변경된 시점과 시간적 이상 징후(역행/누락)를 감지하고, 이를 타임라인 형태의 요약된 이벤트 목록으로 반환합니다.",
  {
    file_path: z.string().describe("분석할 엑셀 파일의 절대 경로")
  },
  async (args) => {
    logToFile(`>>> [요청 수신] ${JSON.stringify(args)}`);

    const filePath = args.file_path;

    if (!filePath || !fs.existsSync(filePath)) {
      logToConsole(`파일 없음: ${filePath}`);
      return { content: [{ type: "text", text: "에러: 파일이 존재하지 않습니다." }], isError: true };
    }

    try {
      const workbook = xlsx.readFile(filePath);
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = xlsx.utils.sheet_to_json(sheet);

      if (!data || data.length === 0) {
        return { content: [{ type: "text", text: "데이터가 비어 있습니다." }] };
      }

      const COL_TIME = "수집일시";
      const COL_DRIVE = "주행상태";
      const COL_CHARGE = "충전상태";
      const COL_MODE = "서비스모드";
      const COL_X = "x좌표";
      const COL_Y = "y좌표";
      const COL_SERVICE = "service";

      let eventLog = [];
      let prevDrive = null; // 이전 주행상태
      let prevCharge = null; // 이전 충전상태
      let prevTime = null; // 이전 수집일시
      let skippedCount = 0; // 건너뛴 행 개수

      // 진행 상황 로깅을 위한 변수
      let processedCount = 0;
      const logInterval = Math.floor(data.length / 10) || 1000;

      data.forEach((row, index) => {
        processedCount++;

        // 진행 상황 로깅 (10% 단위)
        if (processedCount % logInterval === 0) {
            const progress = Math.floor((processedCount / data.length) * 100);
            logToConsole(`처리 진행: ${progress}% (${processedCount}/${data.length})`);
        }

        const timeVal = row[COL_TIME];
        const driveVal = Number(row[COL_DRIVE]);
        const chargeVal = String(row[COL_CHARGE]).toLowerCase();
        const modeVal = row[COL_MODE];

        const xVal = row[COL_X] !== undefined ? Number(row[COL_X]).toFixed(2) : '-';
        const yVal = row[COL_Y] !== undefined ? Number(row[COL_Y]).toFixed(2) : '-';
        let serviceVal = row[COL_SERVICE] || '-';

        if (String(serviceVal).length > 1000) {
            serviceVal = String(serviceVal).substring(0, 997) + "...";
        }

        const parsedDate = parseDate(timeVal);
        const dateStr = parsedDate?.toLocaleString() || timeVal;
        const driveText = getDriveText(driveVal);
        const chargeText = getChargeText(chargeVal);

        const locationInfo = `(서비스모드: ${modeVal} | 위치: ${xVal}, ${yVal} | 서비스: ${serviceVal})`;

        // 수집일시 형식 검증
        if (!timeVal || !isValidDateFormat(String(timeVal))) {
            skippedCount++;
            eventLog.push(`[${dateStr}] 수집일시 형식 오류: "${timeVal}" (YYYY-MM-DD HH:MI:SS 형식이 아님) - 건너뜀`);
            return; // 이 행 건너뛰기
        }

        // 첫 데이터 기록
        if (index === 0) {
            eventLog.push(`[${dateStr}] >>> 분석 시작 (초기상태: ${driveText}, ${chargeText}, ${locationInfo})`);
        }

        // 0. 수집일시 간격(>= 1분) 감지 및 시간 역행 감지
        if (parsedDate && prevTime) {
            const diffMs = parsedDate.getTime() - prevTime.getTime();

            // 시간 역행 감지 (현재 시간이 이전 시간보다 과거인 경우)
            if (diffMs < 0) {
                const prevStr = prevTime.toLocaleString();
                const currentStr = parsedDate.toLocaleString();
                eventLog.push(
                    `[${dateStr}] 시간 역행 오류: 이전 수집일시 ${prevStr} → 현재 ${currentStr} (${formatDuration(Math.abs(diffMs))} 과거로 이동)`
                );
                // 이 행을 건너뛰고 prevTime 유지
                return;
            }

            // 5분 이상 간격 감지
            if (diffMs >= 300_000) {
                const prevStr = prevTime.toLocaleString();
                const diffText = formatDuration(diffMs);
                eventLog.push(
                    `[${dateStr}] 수집 간격 초과: 이전 수집일시 ${prevStr} 대비 ${diffText} 지연`
                );
            }
        }

        // 1. 주행 상태 변화 감지
        if (prevDrive !== null && prevDrive !== driveVal) {
            const prevText = getDriveText(prevDrive);
            eventLog.push(`[${dateStr}] 주행 상태 변경: ${prevText} ➔ ${driveText} ${locationInfo}`);
        }

        // 2. 충전 상태 변화 감지
        if (prevCharge !== null && prevCharge !== chargeVal) {
            const prevText = getChargeText(prevCharge);
            eventLog.push(`[${dateStr}] 충전 상태 변경: ${prevText} ➔ ${chargeText} ${locationInfo}`);
        }

        // 3. 상태 변화가 없더라도 파일의 마지막 행이면 현재 상태를 출력
        if (index === data.length - 1) {
             eventLog.push(`[${dateStr}] >>> 분석 종료 (최종상태: ${driveText}, ${chargeText}, ${locationInfo})`);
        }

        prevDrive = driveVal;
        prevCharge = chargeVal;
        if (parsedDate) prevTime = parsedDate;
      });

      // 로그 길이 제한 (너무 길면 자름)
      if (eventLog.length > 10000) {
          eventLog = eventLog.slice(0, 10000);
          eventLog.push("... (이후 데이터 생략됨)");
      }

      const resultText = `
                            [로봇 데이터 분석 결과]
                            파일명: ${path.basename(filePath)}
                            총 데이터: ${data.length}행
                            건너뛴 행: ${skippedCount}행 (날짜 형식 오류)
                            감지된 이벤트: ${eventLog.length}건

                            --- 타임라인 (Timeline) ---
                            ${eventLog.join('\n')}
                            --- 끝 ---
                        `;

      logToFile(`>>> [완료] ${eventLog.length}건 반환 (${skippedCount}행 건너뜀)`);
      logToConsole(`변환된 데이터 전송 완료 (${eventLog.length}건, ${skippedCount}행 건너뜀)`);

      return {
        content: [{ type: "text", text: resultText }]
      };

    } catch (error) {
      logToFile(`!!! 에러: ${error.message}`);
      return { content: [{ type: "text", text: `오류 발생: ${error.message}` }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logToFile("=== 서버 시작 (Value Mapping Applied) ===");
  logToConsole("서버 시작됨: 상태값 치환 기능 적용완료");
}

main();