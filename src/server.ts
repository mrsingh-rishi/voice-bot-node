import express, { Request, Response } from "express";
import { Twilio } from "twilio";
import dotenv from "dotenv";
import { WebSocket } from "ws";
import http from "http";
import { URL } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const twilioClient = new Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
const baseWsUrl = process.env.BASE_WS_URL || `ws://localhost:${PORT}`;

// Create HTTP server and WebSocket server using noServer so that we can handle upgrade manually.
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.use(express.json());

// Basic health route
app.get("/", (_req: Request, res: Response) => {
  res.send("Hello World!");
});

// Route to create a call using Twilio
app.post("/create-call", async (req: Request, res: Response): Promise<void> => {
  try {
    const { to } = req.body;
    if (!to) {
      res.status(400).send('Missing "to" parameter');
      return;
    }
    const call = await twilioClient.calls.create({
      url: `${baseUrl}/voice`,
      method: "GET",
      statusCallback: `${baseUrl}/status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      timeout: 30,
      machineDetection: "Enable",
      machineDetectionTimeout: 30,
      to,
      from: process.env.TWILIO_PHONE_NUMBER as string,
    });
    res.status(200).json({ callSid: call.sid });
  } catch (error) {
    console.error("Error creating call:", error);
    res.status(500).send("Internal Server Error");
  }
});

// Callback endpoint for Twilio call status updates
app.use(express.urlencoded({ extended: true }));

app.post("/status", (req: Request, res: Response): void => {
  try {
    console.log("Status Callback:", req.body);
    // Handle status callback events as needed
    res.status(200).send("Status Callback Received");
  } catch (error) {
    console.error("Error handling status callback:", error);
    res.status(500).send("Internal Server Error");
  }
});

// TwiML endpoint to instruct Twilio how to handle the call, including streaming to a WebSocket
app.get("/voice", (req: Request, res: Response) => {
  // You might get a CallId from query or set some unique identifier if needed.
  const callId = req.query.CallId || '';
  const twiml = `
<Response>
  <Start>
    <Stream url="${baseWsUrl}/stream?CallId=${callId}" />
  </Start>
  <Say voice="alice">Hello, this is Matilda. How may I help you?</Say>
  <Pause length="60"/>
</Response>`;
  res.type("text/xml");
  res.send(twiml);
});

// A simple route to check the WebSocket server status
app.get("/ws", (_req: Request, res: Response): void => {
  res.send("WebSocket server is running");
});

// Remove any conflicting HTTP endpoint for /stream as it will be handled by WebSocket upgrade.

// Handle HTTP Upgrade requests for WebSocket connections
server.on("upgrade", (request, socket, head) => {
  // Parse the URL to determine if the connection should be handled by the WebSocket server
  const parsedUrl = new URL(request.url || "", `http://${request.headers.host}`);
  if (parsedUrl.pathname === "/stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket connection handler with proper query parsing
wss.on("connection", (ws: WebSocket, request: http.IncomingMessage) => {
  // Parse the query parameters from the request URL
  const parsedUrl = new URL(request.url || "", `http://${request.headers.host}`);
  const callId = parsedUrl.searchParams.get("CallId") || "";
  console.log("WebSocket connection established for CallId:", callId);

  ws.on("message", (message: string) => {
    const base64Message = Buffer.from(message, 'base64').toString('utf-8');
    const jsonMessage = JSON.parse(base64Message);
    if (jsonMessage.event === "media" && jsonMessage.media) {
      const mediaData = jsonMessage.media;
      const mediaChunk = mediaData.payload;

      console.log("Received media chunk:", mediaChunk);
    }
    if (jsonMessage.event === "stop") {
      console.log("Received stop command");
      ws.close();
    }
  });

  ws.on("close", () => {
    console.log("WebSocket connection closed for CallId:", callId);
  });
});

// Start the HTTP server
server.listen(PORT, () => {
  console.log(`Server is running on ${baseUrl}`);
});
