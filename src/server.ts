import express, { Request, Response } from "express";
import { Twilio } from "twilio";
import dotenv from "dotenv";
import { WebSocket } from "ws";
import http from "http";
import { URL } from "url";
import { createClient, ListenLiveClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import { ElevenLabsClient, play } from "elevenlabs";
dotenv.config();
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const PORT = process.env.PORT || 3000;
const twilioClient = new Twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
const baseWsUrl = process.env.BASE_WS_URL || `wss://localhost:${PORT}`;
const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const elevenlabClient = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
});
let connectedWss: WebSocket;
let streamId: string | null = null;

// Create HTTP server and WebSocket server using noServer so that we can handle upgrade manually.
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
let deepgramWs: ListenLiveClient;
const assistantScript = `You are Matilda, a virtual assistant. You are friendly and helpful. You can answer questions, provide information, and assist with tasks. Always be polite and professional.`;
app.use(express.json());
let conversationHistory: Message[] = [];
conversationHistory.push({
  role: "system",
  content: assistantScript,
})
// types for messages
interface Message {
  role: "system" |"user" | "assistant";
  content: string;
}

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
      record: true, // Enable call recording
      recordingStatusCallback: `${baseUrl}/status`, // Optional: Callback for recording status updates
      recordingStatusCallbackMethod: "POST", // Optional: HTTP method for recording status callback
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
  <Connect>
    <Stream url="${baseWsUrl}/stream?CallId=${callId}" bidirectional="true" />
  </Connect>
</Response>`;
//   const twiml = `
// <?xml version="1.0" encoding="UTF-8"?>
// <Response>
//   <Connect>
//     <Stream url="${baseWsUrl}/stream?CallId=${callId}" />
//   </Connect>
// </Response>`;
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
        // console.log(data);
        const transcript = data.channel.alternatives[0]?.transcript;
        if(transcript && data.speech_final) {
          console.log("Final Transcript:", transcript);
          const response = generateResponse(transcript);
          response.then((message) => {
            speak(message, connectedWss).then(() => {
              
            }).catch((error) => {
              console.error("Error sending audio:", error);
            });
          }
          );
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
  connectedWss = ws;
  // Parse the query parameters from the request URL.
  const parsedUrl = new URL(request.url || "", `http://${request.headers.host}`);
  const callId = parsedUrl.searchParams.get("CallId") || "";
  console.log("WebSocket connection established for CallId:", callId);
  speak("Hello! This is Matilda, your virtual assistant. How can I assist you today?", ws).then(() => {
    console.log("Initial greeting sent.");
  }).catch((error) => {
    console.error("Error sending initial greeting:", error);
  });
  ws.on("message", (message: string) => {
    try {
      // Parse the incoming message as JSON.
      const jsonMessage = JSON.parse(message);
      streamId = jsonMessage.streamSid;
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
        // Close the Deepgram connection.
        if (deepgramWs) {
          deepgramWs.finish();
        }
        // empty the message history
        conversationHistory = [];
        conversationHistory.push({
          role: "system",
          content: assistantScript,
        });
        ws.close();
      }
    } catch (err) {
      console.error("Error processing message:", err);
    }
  });

  ws.on("close", () => {
    console.log("WebSocket connection closed for CallId:", callId);
    deepgramWs.finish();
  });
});

// Start the HTTP server.
server.listen(PORT, () => {
  console.log(`Server is running on ${baseUrl}`);
});


const generateResponse = async (transcript: string): Promise<string> => {
  const messages = updateConversationHistory({ role: "user", content: transcript });
  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 100,
    });

    const messageContent = response.choices[0]?.message?.content;
    if (!messageContent) {
      throw new Error("No message content found");
    }

    console.log("Generated response:", messageContent);
    updateConversationHistory({ role: "assistant", content: messageContent });
    return messageContent;
  } catch (error) {
    console.error("Error generating response:", error);
    const fallbackMessage = "Sorry, I couldn't process your request.";
    updateConversationHistory({ role: "assistant", content: fallbackMessage });
    console.log("Generated fallback response:", fallbackMessage);
    return fallbackMessage;
  }
};

const updateConversationHistory = ({ content, role }: { content: string; role: "user" | "assistant" }): Message[] => {
  conversationHistory.push({ role, content });
  return conversationHistory;
};

const speak = async (text: string, ws: WebSocket): Promise<void> => {
  try {
    // Request the audio stream with timestamps from ElevenLabs.
    const audio = await elevenlabClient.textToSpeech.streamWithTimestamps(
      "21m00Tcm4TlvDq8ikWAM",  // your voice ID
      { 
        text, 
        output_format: "ulaw_8000", 
        model_id: "eleven_multilingual_v2",
        enable_logging: true
      }
    );
    
    console.log("Audio stream started");

    // Iterate over the asynchronous stream of audio chunks.
    for await (const item of audio) {
      // Each audio chunk from ElevenLabs is expected to contain a base64-encoded audio string.
      const payload = {
        event: "media",
        streamSid: streamId,
        media: {
          payload: item.audio_base64
        }
      };

      console.log("Sending payload to Twilio:");
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
      } else {
        console.warn("WebSocket is not open. Could not send payload.");
      }
    }

    // After all chunks have been sent, send a mark event to indicate the end of the audio stream.
    const markPayload = {
      event: "mark",
      streamSid: streamId,
      mark: {
        name: "audio chunks sent"
      }
    };
    
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(markPayload));
    }
    console.log("Audio stream ended and mark event sent.");
    
  } catch (error) {
    console.error("Error in speak function:", error);
  }
};