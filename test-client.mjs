import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
    console.log("=== 클라이언트 시작 ===");

    const transport = new StdioClientTransport({
        command: "node",
        args: ["D:/excel-analyzer-mcp/server.js"]
    });

    const client = new Client(
        {
            name: "excel_analyzer_tester",
            version: "1.0.0",
        },
        {
            capabilities: {}
        }
    );

    console.log("=== 서버 연결 중 ===");
    await client.connect(transport);
    console.log("=== 서버 연결 완료 ===");

    console.log("=== 도구 목록 조회 중 ===");
    const tools = await client.listTools();
    console.log("사용 가능한 도구:", tools.tools.map(t => t.name));

    const excelPath = "C:/Users/82222190/Downloads/robot_cycle_2025-12-11.xlsx";

    console.log("\n=== 도구 호출 시작 ===");
    console.log(`파일 경로: ${excelPath}`);

    try {
        const result = await client.callTool({
            name: "fetch_robot_events",
            arguments: {
                file_path: excelPath
            }
        });

        console.log("\n=== RESULT 전체 구조 ===");
        console.log(JSON.stringify(result, null, 2));

        console.log("\n=== 결과 내용 ===");
        if (result.content && Array.isArray(result.content)) {
            for (const block of result.content) {
                if (block.type === "text") {
                    console.log(block.text);
                }
            }
        } else {
            console.log("결과 내용이 없습니다.");
        }
    } catch (error) {
        console.error("\n!!! 도구 호출 중 오류 발생 !!!");
        console.error("에러 메시지:", error.message);
        console.error("에러 스택:", error.stack);
        if (error.data) {
            console.error("에러 데이터:", JSON.stringify(error.data, null, 2));
        }
    }

    console.log("\n=== 클라이언트 종료 ===");
    await client.close();
}

main().catch(err => {
    console.error("\n!!! 메인 함수 실행 중 오류 !!!");
    console.error("ERROR:", err.message);
    console.error("STACK:", err.stack);
    if (err.data) {
        console.error("ERROR DATA:", JSON.stringify(err.data, null, 2));
    }
    process.exit(1);
});
