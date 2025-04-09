import express, { Request, Response } from "express";
import { Twilio } from "twilio";
import dotenv from "dotenv";
import { WebSocket } from "ws";
import http from "http";
import { URL } from "url";
import { createClient, ListenLiveClient, LiveTranscriptionEvents } from "@deepgram/sdk";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const twilioClient = new Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
const baseWsUrl = process.env.BASE_WS_URL || `wss://localhost:${PORT}`;
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

// Create HTTP server and WebSocket server using noServer so that we can handle upgrade manually.
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
let deepgramWs: ListenLiveClient;

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
    res.status(200).send("Status Callback Received");
  } catch (error) {
    console.error("Error handling status callback:", error);
    res.status(500).send("Internal Server Error");
  }
});

// TwiML endpoint to instruct Twilio how to handle the call, including streaming to a WebSocket
app.get("/voice", (req: Request, res: Response) => {
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

// Handle HTTP Upgrade requests for WebSocket connections
server.on("upgrade", (request, socket, head) => {
  const parsedUrl = new URL(request.url || "", `http://${request.headers.host}`);
  if (parsedUrl.pathname === "/stream") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Create a new Deepgram live transcription connection per Twilio stream connection.
      deepgramWs = deepgram.listen.live({
        model: "nova-3",
        language: "en-US",
        smart_format: true,
        punctuate: true,
        interim_results: true,
        encoding: "mulaw",
        sample_rate: 8000,
        channels: 1,
      });

      // Attach event listeners for the Deepgram connection.
      deepgramWs.on(LiveTranscriptionEvents.Open, () => {
        console.log("Deepgram connection opened.");
      });

      deepgramWs.on(LiveTranscriptionEvents.Transcript, (data) => {
        console.log("Deepgram Transcript:");
        console.log(data.channel.alternatives[0]?.transcript);
        const transcript = data.channel.alternatives[0]?.transcript;
        if(transcript) {
          // send transcript to openAI here
        }
      });

      deepgramWs.on(LiveTranscriptionEvents.Metadata, (data) => {
        console.log("Deepgram Metadata:", data);
      });

      deepgramWs.on(LiveTranscriptionEvents.Error, (err) => {
        console.error("Deepgram Error:", err);
      });

      // Pass the Deepgram connection as a property on the WebSocket to use later.
      (ws as any).deepgramWs = deepgramWs;
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket connection handler with proper query parsing
wss.on("connection", (ws: WebSocket, request: http.IncomingMessage) => {
  // Parse the query parameters from the request URL.
  const parsedUrl = new URL(request.url || "", `http://${request.headers.host}`);
  const callId = parsedUrl.searchParams.get("CallId") || "";
  console.log("WebSocket connection established for CallId:", callId);

  ws.on("message", (message: string) => {
    try {
      // Parse the incoming message as JSON.
      const jsonMessage = JSON.parse(message);
      // Check for Twilio "media" event.
      if (jsonMessage.event === "media" && jsonMessage.media && jsonMessage.media.payload) {
        // Decode the base64 audio payload into a Buffer.
        const audioBuffer = Buffer.from(jsonMessage.media.payload, 'base64');
        // Retrieve this connection's Deepgram client.
        const dgWs = deepgramWs;
        // Send the binary audio chunk to Deepgram.
        dgWs.send(audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength));
      }
      // Handle stop command if sent.
      if (jsonMessage.event === "stop") {
        console.log("Received stop command");
        ws.close();
      }
    } catch (err) {
      console.error("Error processing message:", err);
    }
  });

  ws.on("close", () => {
    console.log("WebSocket connection closed for CallId:", callId);
    // Optionally, you can also close the Deepgram connection here.
    const dgWs: ListenLiveClient = (ws as any).deepgramWs;
    if (dgWs) {
      dgWs.finish();
    }
  });
});

// Start the HTTP server.
server.listen(PORT, () => {
  console.log(`Server is running on ${baseUrl}`);
});
