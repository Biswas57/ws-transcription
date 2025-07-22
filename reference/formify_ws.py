import os, json
import tempfile, asyncio, requests
from asgiref.sync import sync_to_async
from channels.generic.websocket import AsyncWebsocketConsumer
from .gpt_parse import parseTranscribedText, parseFinalAttributes

MIN_CHUNK_NUM = 8
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions"
class TranscriptionConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        formid = self.scope['url_route']['kwargs']['formid']
        await self.accept()
        self.nchunks = 0
        self.audio_buffer = b""
        self.full_transcript = ""   # Cumulative transcription
        self.prev_trancript = ""    # Look back for better attribute extraction
        self.curr_transcript = ""  # Most recent transcription
        self.all_attributes = []     # Cumulative list of all attribute dictionaries
        self.current_attributes = {} # Cumulative current attribute dictionary
        form = await sync_to_async(Form.objects.get)(id=formid)

        # Build the prompt to send to OpenAI
        self.template = []
        for block in await sync_to_async(list)(form.blocks.all()):  # Convert queryset to list asynchronously
            for field in await sync_to_async(list)(block.fields.all()):
                self.template.append({
                    "block_name": block.block_name,
                    "field_name": field.field_name,
                    "field_type": field.field_type
                })

        self.webm_header = None  # store the first valid chunk as header
        self.final_sweep_completed = False


    async def disconnect(self, close_code):
        # On disconnect, if no final sweep was performed, send the current data
        if not self.final_sweep_completed:
            await self.send(text_data=json.dumps({
                "corrected_audio": self.full_transcript,
                "attributes": self.current_attributes
            }))

    async def receive(self, bytes_data=None, text_data=None):
        # Handle text data (control messages)
        if text_data:
            data = json.loads(text_data)
            if data.get('action') == 'stop_recording':
                # Process final sweep
                final_attributes = await self.process_final_sweep()
                self.final_sweep_completed = True
                
                # Send final results
                await self.send(text_data=json.dumps({
                    "final_results": True,
                    "corrected_audio": self.full_transcript,
                    "attributes": final_attributes
                }))
                return

        # Handle binary data (audio chunks)
        if bytes_data:
            if not self.template:
                # Hard-coded template; ideally, load from your DB.
                self.template = ["name", "DOB", "Location", "Place of Birth"]

            # Check if this incoming chunk has a valid WebM header signature.
            if self.webm_header is None and self.check_webm_integrity(bytes_data):
                # Store the entire first chunk as the header.
                self.webm_header = bytes_data
                self.audio_buffer += bytes_data
                print("Stored WebM header from initial chunk.")
            else:
                # For subsequent chunks, if they appear to include a header signature,
                # strip the first 4 bytes (the EBML signature) to avoid duplicate headers.
                if self.check_webm_integrity(bytes_data):
                    print("Detected header in subsequent chunk. Stripping first 4 bytes.")
                    self.audio_buffer += bytes_data[4:]
                else:
                    self.audio_buffer += bytes_data

            self.nchunks += 1

            if self.nchunks >= MIN_CHUNK_NUM:
                # Ensure the aggregated audio starts with a valid header.
                audio_data = self.audio_buffer
                if not self.check_webm_integrity(audio_data) and self.webm_header:
                    audio_data = self.webm_header + audio_data

                # threading loop to ensure efficient gpt parsing 
                # minimising effects of blocking functions
                transcription = await self.run_whisper_on_buffer(audio_data)
                loop = asyncio.get_event_loop()
                fixed_transcript, extracted_attributes = await loop.run_in_executor(
                    None,
                    parseTranscribedText,
                    self.prev_trancript,
                    transcription,
                    self.current_attributes,
                    self.template
                )
                self.prev_trancript = self.curr_transcript
                self.curr_transcript = fixed_transcript
                self.full_transcript += fixed_transcript

                # Append to the full history (if needed)
                self.all_attributes.append(extracted_attributes)
                # Update the cumulative current attribute dictionary.
                self.current_attributes.update(extracted_attributes)

                # Send the latest transcription and cumulative current attributes.
                await self.send(text_data=json.dumps({
                    "corrected_audio": self.prev_trancript + self.curr_transcript,
                    "attributes": self.current_attributes  # cumulative current attributes
                }))

                # Reset for the next aggregation round.
                self.audio_buffer = b""
                self.nchunks = 0

    async def process_final_sweep(self):
        """
        Process the complete transcript to verify and correct the extracted attributes.
        """
        # Retrieve the form instance
        form = await sync_to_async(Form.objects.get)(id=self.scope['url_route']['kwargs']['formid'])
        
        # Build the candidate attributes list for the prompt
        field_list = []
        for block in await sync_to_async(list)(form.blocks.all()):
            for field in await sync_to_async(list)(block.fields.all()):
                field_list.append({
                    "block_name": block.block_name,
                    "field_name": field.field_name,
                    "field_type": field.field_type,
                    "current_value": self.current_attributes.get(field.field_name, "N/A")
                })
        
        # Call the final attribute extraction process asynchronously
        final_attributes = await parseFinalAttributes(self.full_transcript, field_list)
        print("Final sweep completed. Verified attributes:", final_attributes)
        return final_attributes
        
    
    def check_webm_integrity(self, audio_data):
        """
        Checks whether the audio_data starts with the minimal WebM EBML header signature.
        The EBML header for WebM typically starts with the 4-byte sequence: 0x1A45DFA3.
        """
        if len(audio_data) < 4:
            return False
        return audio_data[0:4] == b'\x1A\x45\xDF\xA3'

    async def run_whisper_on_buffer(self, audio_data):
        with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as tmp:
            tmp.write(audio_data)
            tmp.flush()
            filename = tmp.name
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, self.call_whisper_api, filename)
        return result.get('text', '')

    def call_whisper_api(self, filename):
        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}"
        }
        data = {
            "model": "whisper-1"
        }
        with open(filename, "rb") as f:
            files = {"file": (filename, f, "audio/webm")}
            response = requests.post(WHISPER_API_URL, headers=headers, data=data, files=files)
        if response.status_code == 200:
            return response.json()
        else:
            print(f"Error calling Whisper API: {response.status_code} {response.text}")
            return {"text": ""}