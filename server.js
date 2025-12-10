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
  "엑셀 파일에서 로봇의 상태가 변경된 시점(이벤트)들의 목록을 추출합니다.",
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
      const COL_X = "x좌표";
      const COL_Y = "y좌표";
      const COL_SERVICE = "service";

      let eventLog = []; 
      let prevDrive = null;
      let prevCharge = null;

      data.forEach((row, index) => {
        const timeVal = row[COL_TIME];
        const driveVal = Number(row[COL_DRIVE]); 
        const chargeVal = String(row[COL_CHARGE]).toLowerCase(); 

        const xVal = row[COL_X] !== undefined ? Number(row[COL_X]).toFixed(2) : '-';
        const yVal = row[COL_Y] !== undefined ? Number(row[COL_Y]).toFixed(2) : '-';
        let serviceVal = row[COL_SERVICE] || '-';

        if (String(serviceVal).length > 200) {
            serviceVal = String(serviceVal).substring(0, 197) + "...";
        }

        if (!timeVal) return;
        const dateStr = parseDate(timeVal)?.toLocaleString() || timeVal;
        const driveText = getDriveText(driveVal);
        const chargeText = getChargeText(chargeVal);

        const locationInfo = `(위치: ${xVal}, ${yVal} | 서비스: ${serviceVal})`;

        // 첫 데이터 기록
        if (index === 0) {
            eventLog.push(`[${dateStr}] >> 분석 시작 (초기상태: ${driveText}, ${chargeText}, ${locationInfo})`);
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

        prevDrive = driveVal;
        prevCharge = chargeVal;
      });

      // 로그 길이 제한 (너무 길면 자름)
      if (eventLog.length > 5000) {
          eventLog = eventLog.slice(0, 5000);
          eventLog.push("... (이후 데이터 생략됨)");
      }

      const resultText = `
                            [로봇 데이터 분석 결과]
                            파일명: ${path.basename(filePath)}
                            총 데이터: ${data.length}행
                            감지된 이벤트: ${eventLog.length}건

                            --- 타임라인 (Timeline) ---
                            ${eventLog.join('\n')}
                            --- 끝 ---
                        `;

      logToFile(`>>> [완료] ${eventLog.length}건 반환`);
      logToConsole(`변환된 데이터 전송 완료 (${eventLog.length}건)`);
      
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