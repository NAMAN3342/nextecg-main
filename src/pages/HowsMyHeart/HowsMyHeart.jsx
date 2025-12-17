import React, { useRef, useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

// Helper to split text stream by newlines
class LineBreakTransformer {
  constructor() { this.container = '' }
  transform(chunk, controller) {
    this.container += chunk;
    const lines = this.container.split('\n');
    this.container = lines.pop();
    for (const line of lines) controller.enqueue(line);
  }
  flush(controller) {
    if (this.container) controller.enqueue(this.container);
  }
}

function computeStats(arr) {
  if (!arr || arr.length === 0) return {mean:0,sd:0};
  const mean = arr.reduce((a,b) => a+b,0)/arr.length;
  const sd = Math.sqrt(arr.reduce((a,b)=>a+(b-mean)*(b-mean),0)/arr.length);
  return {mean,sd};
}

export default function HowsMyHeart() {
  const navigate = useNavigate()
  const canvasRef = useRef(null);
  const [port, setPort] = useState(null);
  const [bpm, setBpm] = useState(null);
  const [lastSerialLine, setLastSerialLine] = useState('');
  const [lastParsedBpm, setLastParsedBpm] = useState(null);
  const [lastParsedIrr, setLastParsedIrr] = useState(null);
  const [healthCategory, setHealthCategory] = useState({level:'--',score:0,desc:''});
  const [showHealthInfo, setShowHealthInfo] = useState(false);
  const [breakdown, setBreakdown] = useState({brady:0,tachy:0,irregularity:0});
  const [calibrating, setCalibrating] = useState(false);
  const [monitoringActive, setMonitoringActive] = useState(false);
  const [sessionComplete, setSessionComplete] = useState(false); // Lock results after measurement
  const samplesRef = useRef([]); // Lead II (A1) samples - circular buffer
  const samples2Ref = useRef([]); // Lead I (A0) samples - circular buffer
  const beatsRef = useRef([]); // timestamps (ms) of heart beats (from bpm messages)
  const MAX_SAMPLES = 1500; // ~12 seconds at 125 Hz
  const ARDUINO_SAMPLE_RATE = 125; // Hz - incoming sample rate from Arduino
  const SAMPLE_PERIOD_MS = 1000 / ARDUINO_SAMPLE_RATE;
  const lastBeatTime = useRef(0);
  const peakThreshold = useRef(0.3); // Dynamic threshold for R-peak detection

  useEffect(() => {
    let anim = true;
    const render = () => {
      if (!anim) return;
      drawCanvas();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
    return () => { anim = false };
  }, []);

  // Browser-side R-peak detector (runs on Lead II / samplesRef)
  useEffect(() => {
    const MIN_BEAT_INTERVAL = 300; // ms
    let lastPeakTime = 0;
    let lastProcessedIndex = 0;

  const detectionInterval = setInterval(() => {
      const samples = samplesRef.current;
      const n = samples.length;
      if (n < 50) return;

      // compute recent stats for adaptive thresholding
      const recent = samples.slice(Math.max(0, n - 200));
      const mean = recent.reduce((a,b) => a + b, 0) / recent.length;
      const variance = recent.reduce((a,b) => a + Math.pow(b - mean, 2), 0) / recent.length;
      const sd = Math.sqrt(variance);
      const thresh = mean + Math.max(0.25, sd * 0.8); // adaptive threshold

      // scan new samples for local peaks
      for (let i = Math.max(1, lastProcessedIndex); i < n - 1; i++) {
        const v = samples[i];
        if (v > samples[i-1] && v > samples[i+1] && v > thresh) {
          const now = Date.now();
          if (now - lastPeakTime > MIN_BEAT_INTERVAL) {
            // Detected beat
            lastPeakTime = now;
            beatsRef.current.push(now);
            if (beatsRef.current.length > 50) beatsRef.current.splice(0, beatsRef.current.length - 50);

            // compute BPM from last interval
            if (beatsRef.current.length >= 2) {
              const ibi = now - beatsRef.current[beatsRef.current.length - 2];
              const measuredBpm = Math.round(60000 / ibi);
              setBpm(measuredBpm);
            }

            // compute irregularity (CV) from last intervals
            if (beatsRef.current.length >= 3) {
              const ibis = [];
              for (let j = 1; j < beatsRef.current.length; j++) ibis.push(beatsRef.current[j] - beatsRef.current[j-1]);
              const lastIbis = ibis.slice(-8);
              const meanI = lastIbis.reduce((a,b) => a + b, 0) / lastIbis.length;
              let varI = 0;
              for (const x of lastIbis) varI += Math.pow(x - meanI, 2);
              varI /= lastIbis.length;
              const sdI = Math.sqrt(varI);
              const cv = meanI > 0 ? sdI / meanI : 0;
              const irrNorm = Math.min(1, cv * 3.0);
              // expose to health calculator (same shape as Arduino irregularity)
              if (!window.arduinoIrregularity) window.arduinoIrregularity = [];
              window.arduinoIrregularity.push(irrNorm);
              if (window.arduinoIrregularity.length > 10) window.arduinoIrregularity.shift();
            }
          }
        }
      }

      lastProcessedIndex = Math.max(0, n - 2);
  }, Math.max(20, Math.round(SAMPLE_PERIOD_MS * 4))); // run every ~4 samples (32ms at 125Hz)

    return () => clearInterval(detectionInterval);
  }, []);

  useEffect(() => {
    // whenever beatsRef updates or bpm changes, recompute rhythm metrics
    const compute = () => {
      const beats = beatsRef.current;
      const hasArduinoIrr = window.arduinoIrregularity && window.arduinoIrregularity.length > 0;
      // Require sufficient data before showing health analysis
      if (!monitoringActive) {
        setHealthCategory({level:'Calibrating...', score:0, desc:'Collecting baseline ECG data for accurate analysis.'});
        return;
      }
      // If we don't have Arduino irregularity, require at least 3 beat timestamps to compute rhythm.
      if (!hasArduinoIrr && beats.length < 3) {
        setHealthCategory({level:'Analyzing...', score:0, desc:'Collecting heartbeat data for rhythm assessment.'});
        return;
      }

      // Get irregularity from Arduino if available
      let irregularity = 0;
      if (hasArduinoIrr) {
        // Use latest irregularity from Arduino (coefficient of variation)
        const recent = window.arduinoIrregularity.slice(-5);
        irregularity = recent.reduce((a,b) => a+b, 0) / recent.length;
      } else {
        // Fallback: compute inter-beat intervals (ms) from web-based detection
        const ibis = [];
        for (let i=1;i<beats.length;i++) ibis.push(beats[i] - beats[i-1]);
        // use last 8 IBIs
        const last = ibis.slice(-8);
        const {mean, sd} = computeStats(last);
        const cv = mean > 0 ? sd / mean : 0; // coefficient of variation
        irregularity = Math.min(1, cv * 3.0); // scale factor
      }

      // heart rate rules
      const hr = bpm || 70; // Use Arduino BPM

      // Health index scoring (higher is worse)
      let bradyScore = 0;
      let tachyScore = 0;
      // bradycardia
      if (hr < 50) bradyScore = 40;
      else if (hr < 60) bradyScore = 20;
      // tachycardia
      if (hr > 120) tachyScore = 40;
      else if (hr > 100) tachyScore = 20;
      // irregular rhythm contribution (0..40)
      const irrScore = Math.round(irregularity * 40);

      // total
      let score = bradyScore + tachyScore + irrScore;
      score = Math.max(0, Math.min(100, score));

      let level = 'Normal';
      let desc = 'Heart rate and rhythm are within typical ranges.';
      if (score >= 70) { level = 'High'; desc = 'High concern: heart rate or rhythm suggest elevated risk — seek medical attention if symptomatic.' }
      else if (score >= 35) { level = 'Moderate'; desc = 'Moderate concern: some abnormal findings. Consider monitoring and consulting a clinician.' }

      setBreakdown({brady: bradyScore, tachy: tachyScore, irregularity: irrScore});
      setHealthCategory({level, score, desc});
    };

    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [bpm]);

  // Signal quality monitor - REMOVED (no auto signal quality check)

  function drawCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width = canvas.clientWidth;
    const h = canvas.height = 400;
    
    // White background (standard medical ECG paper)
    ctx.fillStyle = '#fff'; 
    ctx.fillRect(0,0,w,h);
    
    // ECG Grid Paper - Red grid lines on white (standard medical ECG paper)
    // Large grid: 5mm squares (bold red)
    const gridSize = 20; // pixels per 5mm square
    ctx.strokeStyle = '#ff9999';
    ctx.lineWidth = 1.5;
    for (let x = 0; x < w; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    
    // Small grid: 1mm squares (lighter red)
    const smallGrid = gridSize / 5;
    ctx.strokeStyle = '#ffcccc';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < w; x += smallGrid) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += smallGrid) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const samples = samplesRef.current; // Lead II (A1)
    if (samples.length < 2) {
      ctx.fillStyle = '#333'; 
      ctx.font = '14px monospace'; 
      ctx.textAlign = 'center';
      if (calibrating) {
        ctx.fillText('CALIBRATING ECG (10 SECONDS)', w/2, h/2 - 10);
        ctx.fillStyle = '#666'; 
        ctx.font = '11px monospace';
        ctx.fillText('Collecting baseline data', w/2, h/2 + 10);
      } else {
        ctx.fillText('NO ECG SIGNAL', w/2, h/2 - 10);
        ctx.fillStyle = '#666'; 
        ctx.font = '11px monospace';
        ctx.fillText('Connect device to begin monitoring', w/2, h/2 + 10);
      }
      return;
    }
    
    // Draw ECG waveform at 25mm/s paper speed
    // At 125Hz sample rate, 25mm/s = 5 samples per mm = 25 samples per large grid square (5mm)
    // Display last 6 seconds of data (standard ECG strip length)
    const DISPLAY_SECONDS = 6;
    const SAMPLES_TO_DISPLAY = ARDUINO_SAMPLE_RATE * DISPLAY_SECONDS; // 750 samples at 125Hz
    const view = samples.slice(-SAMPLES_TO_DISPLAY);
    
    ctx.strokeStyle = '#000'; // Black trace on white paper (standard ECG)
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    const minV = -2.0; 
    const maxV = 2.0;
    
    for (let i = 0; i < view.length; i++) {
      // 25mm/s: each second uses 25mm of paper width
      // At 125 samples/sec, each sample = 0.2mm = 0.04 * gridSize pixels
      const x = (i / ARDUINO_SAMPLE_RATE) * (25 * gridSize / 5); // 25mm/s scaled to pixels
      const v = view[i];
      const y = h/2 - (v / (maxV - minV)) * h * 0.8;
      if (i === 0) ctx.moveTo(x, y); 
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    
    // Label
    ctx.fillStyle = '#000'; 
    ctx.font = '11px monospace'; 
    ctx.textAlign = 'left';
    ctx.fillText('LEAD II', 10, 20);
    ctx.fillStyle = '#666';
    ctx.fillText('25mm/s', 10, 35);
  }

  // Gauge rendering (modern arc style without needle)
  function Gauge({value}) {
    const min = 30; const max = 180;
    const clamped = Math.max(min, Math.min(max, value || 60));
    const pct = (clamped - min) / (max - min);
    const cx = 110; const cy = 110; const r = 85;

    return (
      <div style={{width:220,height:220,position:'relative'}}>
        <svg width={220} height={220} viewBox="0 0 220 220">
          <defs>
            <linearGradient id="gaugeGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#4ade80" />
              <stop offset="50%" stopColor="#facc15" />
              <stop offset="100%" stopColor="#ef4444" />
            </linearGradient>
          </defs>
          
          {/* Background circle */}
          <circle cx={cx} cy={cy} r={r} stroke="rgba(255,255,255,0.08)" strokeWidth="18" fill="none" />
          
          {/* Colored progress arc */}
          {value && (
            <circle
              cx={cx}
              cy={cy}
              r={r}
              stroke={clamped < 60 ? '#4ade80' : clamped < 100 ? '#facc15' : '#ef4444'}
              strokeWidth="18"
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * r * pct} ${2 * Math.PI * r}`}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{
                filter: `drop-shadow(0 0 8px ${clamped < 60 ? '#4ade8060' : clamped < 100 ? '#facc1560' : '#ef444460'})`,
                transition: 'all 0.3s ease'
              }}
            />
          )}
          
          {/* Tick marks */}
          {[40, 60, 80, 100, 120, 140, 160].map((v,i)=>{
            const p = (v - min) / (max - min);
            const angle = -90 + p*360;
            const a = angle * Math.PI/180;
            const x1 = cx + (r-12)*Math.cos(a);
            const y1 = cy + (r-12)*Math.sin(a);
            const x2 = cx + (r-4)*Math.cos(a);
            const y2 = cy + (r-4)*Math.sin(a);
            return (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#666" strokeWidth={2} />
            )
          })}
        </svg>

        <div style={{position:'absolute',left:0,top:0,width:220,height:220,display:'flex',alignItems:'center',justifyContent:'center',pointerEvents:'none'}}>
          <div style={{textAlign:'center'}}>
            <div style={{fontSize:48,fontWeight:800,color: clamped < 60 ? '#4ade80' : clamped < 100 ? '#facc15' : '#ef4444', letterSpacing:'-2px'}}>{value ? value : '--'}</div>
            <div style={{fontSize:13,color:'#888',letterSpacing:'2px',marginTop:-4}}>BPM</div>
          </div>
        </div>
      </div>
    );
  }

  // Health Index Arrow Gauge
  function HealthGauge({score}) {
    const cx = 70; const cy = 70; const r = 50;
    const angle = -120 + (score / 100) * 240; // -120 to 120 degrees
    
    return (
      <div style={{width:140,height:100,position:'relative'}}>
        <svg width={140} height={100} viewBox="0 0 140 100">
          <defs>
            <linearGradient id="hg" x1="0" x2="1">
              <stop offset="0%" stopColor="#7ef77e" />
              <stop offset="50%" stopColor="#ffb020" />
              <stop offset="100%" stopColor="#ff6b6b" />
            </linearGradient>
          </defs>
          {/* Background arc */}
          <path d={`M ${cx + r*Math.cos(-120*Math.PI/180)} ${cy + r*Math.sin(-120*Math.PI/180)} A ${r} ${r} 0 0 1 ${cx + r*Math.cos(120*Math.PI/180)} ${cy + r*Math.sin(120*Math.PI/180)}`} stroke="url(#hg)" strokeWidth="12" fill="none" strokeLinecap="round" />
          
          {/* Labels */}
          <text x={20} y={85} fill="#7ef77e" fontSize="10" fontWeight="600">Normal</text>
          <text x={cx-20} y={25} fill="#ffb020" fontSize="10" fontWeight="600">Moderate</text>
          <text x={100} y={85} fill="#ff6b6b" fontSize="10" fontWeight="600">High</text>
          
          {/* Arrow needle */}
          <g transform={`translate(${cx},${cy}) rotate(${angle})`}>
            <polygon points="0,-45 -3,-38 3,-38" fill="#fff" stroke="#000" strokeWidth="1" />
            <rect x={-2} y={-38} width={4} height={38} rx={2} fill="#fff" stroke="#000" strokeWidth="1" />
            <circle cx={0} cy={0} r={5} fill="#1a1f28" stroke="#fff" strokeWidth={2} />
          </g>
        </svg>
        
        <div style={{position:'absolute',left:0,top:0,width:140,height:100,display:'flex',alignItems:'flex-end',justifyContent:'center',pointerEvents:'none'}}>
          <div style={{fontSize:18,fontWeight:700,color:'#fff',marginBottom:8}}>{score}</div>
        </div>
      </div>
    )
  }

  async function connectSerial() {
    if (!('serial' in navigator)) {
      alert('Web Serial API not supported in this browser. Use Chrome/Edge and enable experimental features.');
      return;
    }
    try {
      const requestedPort = await navigator.serial.requestPort();
      await requestedPort.open({ baudRate: 115200 });
      setPort(requestedPort);
      setCalibrating(true);
      setMonitoringActive(false); // Don't show analysis during calibration

      // Calibrate for 10 seconds to collect sufficient data before analysis
      setTimeout(() => {
        setCalibrating(false);
        setMonitoringActive(true); // Now show heart rate and rhythm analysis
        
        // After 10 more seconds, lock the results
        setTimeout(() => {
          setSessionComplete(true);
          setMonitoringActive(false);
        }, 10000);
      }, 10000);

      // setup text stream
      const textDecoder = new TextDecoderStream();
      const readableStreamClosed = requestedPort.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable
        .pipeThrough(new TransformStream(new LineBreakTransformer()))
        .getReader();

      // read loop
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        
        const line = value.trim();
        setLastSerialLine(line);
        
        // Detect calibration messages
        if (line.includes('Calibration') || line.includes('Starting') || line.includes('Baseline') || line.includes('Gain')) {
          console.log('Arduino:', line);
          if (line.includes('Complete')) {
            setCalibrating(false);
          }
          continue;
        }
        
        // Parse comma-separated values: value1,value2,bpm,irregularity
        const parts = line.split(',');
        if (parts.length >= 2) {
          const val1 = parseFloat(parts[0]); // Lead I (A0)
          const val2 = parseFloat(parts[1]); // Lead II (A1)
          const arduinoBPM = parts.length >= 3 ? parseInt(parts[2]) : null; // BPM from Arduino
          const arduinoIrregularity = parts.length >= 4 ? parseFloat(parts[3]) : null; // Irregularity from Arduino
          
          if (!isNaN(val1) && !isNaN(val2)) {
            // Store Lead II (A1) as primary
            samplesRef.current.push(val2);
            samples2Ref.current.push(val1);
            
            if (samplesRef.current.length > MAX_SAMPLES) {
              samplesRef.current.splice(0, samplesRef.current.length - MAX_SAMPLES);
              samples2Ref.current.splice(0, samples2Ref.current.length - MAX_SAMPLES);
            }
            
            // Use BPM from Arduino if available
            if (arduinoBPM && arduinoBPM > 0) {
              console.log('Arduino BPM:', arduinoBPM, 'Monitoring:', monitoringActive);
              
              // Store beat timestamps (collect during calibration for later analysis)
              const now = Date.now();
              beatsRef.current.push(now);
              if (beatsRef.current.length > 50) {
                beatsRef.current.splice(0, beatsRef.current.length - 50);
              }

              // Store irregularity value (collect during calibration)
              if (arduinoIrregularity !== null && arduinoIrregularity >= 0) {
                if (!window.arduinoIrregularity) window.arduinoIrregularity = [];
                window.arduinoIrregularity.push(arduinoIrregularity);
                if (window.arduinoIrregularity.length > 10) {
                  window.arduinoIrregularity.shift();
                }
                setLastParsedIrr(arduinoIrregularity);
              }
              
              // Only display BPM after calibration period and if session not complete
              if (monitoringActive && !sessionComplete) {
                setBpm(arduinoBPM);
                setLastParsedBpm(arduinoBPM);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('Serial connect error', err);
      setCalibrating(false);
    }
  }

  async function disconnectSerial() {
    if (!port) return;
    try {
      await port.close();
    } catch(e){}
    setPort(null);
    setCalibrating(false);
    setMonitoringActive(false);
    setSessionComplete(false);
    setBpm(null);
    // Clear all samples
    samplesRef.current = [];
    samples2Ref.current = [];
    beatsRef.current = [];
    if (window.arduinoIrregularity) window.arduinoIrregularity = [];
  }

  async function startMonitoring() {
    setMonitoringActive(true);
  }

  function resetSession() {
    // Reset for new measurement while keeping connection
    setSessionComplete(false);
    setCalibrating(true);
    setMonitoringActive(false);
    setBpm(null);
    samplesRef.current = [];
    samples2Ref.current = [];
    beatsRef.current = [];
    if (window.arduinoIrregularity) window.arduinoIrregularity = [];
    
    // Start new calibration cycle
    setTimeout(() => {
      setCalibrating(false);
      setMonitoringActive(true);
      
      setTimeout(() => {
        setSessionComplete(true);
        setMonitoringActive(false);
      }, 10000);
    }, 10000);
  }



  return (
    <div style={{fontFamily:'monospace',color:'#eee',minHeight:'100vh',padding:20,background:'#000'}}>
      {/* Back Button */}
      <button 
        onClick={() => navigate('/')} 
        style={{
          position: 'fixed',
          top: '20px',
          left: '20px',
          zIndex: 10000,
          background: '#1a1a1a',
          color: '#fff',
          border: '1px solid #333',
          padding: '10px 20px',
          borderRadius: '8px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '14px',
          fontWeight: '600',
          fontFamily: 'monospace'
        }}
      >
        ← Back to Home
      </button>

      {/* Professional Medical Header */}
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:20,background:'#0a0a0a',padding:'12px 20px',borderBottom:'2px solid #1a1a1a',marginTop:'50px'}}>
        <div style={{flex:1}}>
          <h1 style={{
            margin:0,
            color:'#fff',
            fontSize:24,
            fontWeight:700,
            letterSpacing:'2px',
            fontFamily:'monospace'
          }}>
            ECG MONITOR
          </h1>
          <div style={{fontSize:11,color:'#666',marginTop:4,letterSpacing:'1px',fontFamily:'monospace'}}>
            PROFESSIONAL CARDIAC MONITORING SYSTEM
          </div>
        </div>
      </div>

      <div style={{display:'flex',gap:10,marginBottom:20,alignItems:'center'}}>
        {port ? (
          <>
            <button onClick={disconnectSerial} style={{background:'#1a1a1a',color:'#fff',padding:'8px 16px',border:'1px solid #333',borderRadius:4,cursor:'pointer',fontFamily:'monospace'}}>DISCONNECT</button>
            {sessionComplete && (
              <button onClick={resetSession} style={{background:'#006600',color:'#fff',fontWeight:700,padding:'8px 16px',border:'1px solid #008800',borderRadius:4,cursor:'pointer',fontFamily:'monospace'}}>
                TEST AGAIN
              </button>
            )}
            {!monitoringActive && !calibrating && !sessionComplete && (
              <button onClick={startMonitoring} style={{background:'#006600',color:'#fff',fontWeight:700,padding:'8px 16px',border:'1px solid #008800',borderRadius:4,cursor:'pointer',fontFamily:'monospace'}}>
                START MONITORING
              </button>
            )}
            {calibrating && (
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'8px 16px',background:'#1a1a00',border:'1px solid #333'}}>
                <div style={{fontSize:12,color:'#ffaa00',fontFamily:'monospace'}}>CALIBRATING... (10s)</div>
              </div>
            )}
            {monitoringActive && !sessionComplete && (
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'8px 16px',background:'#001a00',border:'1px solid #333'}}>
                <div style={{fontSize:12,color:'#00ff00',fontFamily:'monospace'}}>ANALYZING...</div>
              </div>
            )}
            {sessionComplete && (
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'8px 16px',background:'#000066',border:'1px solid #333'}}>
                <div style={{fontSize:12,color:'#6666ff',fontFamily:'monospace'}}>TEST COMPLETE</div>
              </div>
            )}
          </>
        ) : (
          <button onClick={connectSerial} style={{background:'#1a1a1a',color:'#fff',padding:'8px 16px',border:'1px solid #333',borderRadius:4,cursor:'pointer',fontFamily:'monospace'}}>CONNECT DEVICE</button>
        )}
      </div>

      <div style={{display:'flex',gap:20,marginTop:20,alignItems:'flex-start'}}>
        <div style={{flex:1}}>
          {/* ECG Waveform Canvas */}
          <div style={{display:'flex',gap:12,alignItems:'stretch'}}>
            <div style={{flex:1}}>
              <canvas ref={canvasRef} style={{width:'100%',minHeight:'400px',border:'2px solid #ccc',background:'#fff'}} />
            </div>
            <div style={{width:180,display:'flex',flexDirection:'column',gap:12}}>
              {/* Heart Rate Gauge Block */}
              <div style={{background:'#0a0a0a',padding:16,border:'1px solid #1a1a1a',display:'flex',flexDirection:'column',alignItems:'center',gap:8}}>
                <Gauge value={(monitoringActive && port) ? bpm : null} />
                <div style={{textAlign:'center',marginTop:8}}>
                  <div style={{fontSize:11,color:'#666',marginBottom:4,fontFamily:'monospace'}}>STATUS</div>
                  {calibrating && <span style={{color:'#ffaa00',fontSize:10,fontFamily:'monospace'}}>CALIBRATING</span>}
                  {port && !calibrating && monitoringActive && <span style={{color:'#00ff00',fontSize:10,fontFamily:'monospace'}}>ACTIVE</span>}
                  {port && !calibrating && !monitoringActive && <span style={{color:'#ffaa00',fontSize:10,fontFamily:'monospace'}}>READY</span>}
                  {!port && <span style={{color:'#666',fontSize:10,fontFamily:'monospace'}}>DISCONNECTED</span>}
                </div>
              </div>

              {/* Sample Counter Block */}
              <div style={{background:'#0a0a0a',padding:12,border:'1px solid #1a1a1a',textAlign:'center'}}>
                <div style={{fontSize:10,color:'#666',marginBottom:4,fontFamily:'monospace'}}>SAMPLES</div>
                <div style={{fontSize:20,fontWeight:700,color:'#00ff00',fontFamily:'monospace'}}>{samplesRef.current.length}</div>
                <div style={{fontSize:9,color:'#666',marginTop:4,fontFamily:'monospace'}}>LEAD II</div>
              </div>

              {/* BPM Display */}
              <div style={{background:'#0a0a0a',padding:16,border:'1px solid #1a1a1a',textAlign:'center'}}>
                <div style={{fontSize:11,color:'#666',marginBottom:8,fontFamily:'monospace'}}>HEART RATE</div>
                <div style={{fontSize:48,fontWeight:700,color:'#ff0000',fontFamily:'monospace'}}>{(monitoringActive && bpm) ? bpm : '--'}</div>
                <div style={{fontSize:11,color:'#666',marginTop:4,fontFamily:'monospace'}}>BPM</div>
              </div>

              {/* Debug info */}
              <div style={{marginTop:8,padding:10,background:'#0a0a0a',border:'1px solid #1a1a1a',fontSize:9,color:'#666',fontFamily:'monospace'}}>
                <div style={{fontWeight:700,color:'#888',marginBottom:6}}>DEBUG</div>
                <div>SERIAL: <span style={{color:'#00ff00'}}>{lastSerialLine || 'N/A'}</span></div>
                <div>BPM: <span style={{color:'#00ff00'}}>{lastParsedBpm ?? '--'}</span></div>
                <div>IRR: <span style={{color:'#ffaa00'}}>{lastParsedIrr ?? '--'}</span></div>
                <div style={{marginTop:4}}>MON: {monitoringActive ? 'Y' : 'N'} | PORT: {port ? 'Y' : 'N'}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Heart Health Index - show when monitoring or results locked */}
        {(monitoringActive || sessionComplete) && (
          <div style={{width:360,background:'#0a0a0a',padding:16,border:'2px solid #1a1a1a',color:'#eee'}}>
            <h3 style={{marginTop:0,color:'#fff',fontFamily:'monospace',fontSize:14,letterSpacing:'2px'}}>HEALTH INDEX</h3>
            
            {/* Health Gauge */}
            <div style={{display:'flex',justifyContent:'center',marginBottom:12}}>
              <HealthGauge score={healthCategory.score} />
            </div>
            
            <div style={{fontSize:22,fontWeight:700,textAlign:'center',color: healthCategory.level==='High'?'#ff6b6b': healthCategory.level==='Moderate'?'#ffb020':'#7ef77e'}}>{healthCategory.level}</div>
            <div style={{marginTop:8,color:'#bbb',textAlign:'center'}}>{healthCategory.desc}</div>
            <div style={{marginTop:12}}>
              <div style={{fontSize:13,fontWeight:700,color:'#fff'}}>Why this score?</div>
              <div style={{marginTop:8}}>
                <div className="small" style={{color:'#aaa'}}>Heart rate contribution</div>
                <div style={{height:10,background:'#1e2836',borderRadius:6,overflow:'hidden'}}>
                  <div style={{width:`${breakdown.brady + breakdown.tachy}%`,height:'100%',background:'#ffb020'}} />
                </div>
                <div style={{marginTop:6,color:'#aaa'}} className="small">Rhythm irregularity contribution</div>
                <div style={{height:10,background:'#1e2836',borderRadius:6,overflow:'hidden'}}>
                  <div style={{width:`${breakdown.irregularity}%`,height:'100%',background:'#ff6b6b'}} />
                </div>
                <div style={{marginTop:8,fontSize:13,color:'#ccc'}}>
                  <div><strong>Brady:</strong> {breakdown.brady} pts &middot; <strong>Tachy:</strong> {breakdown.tachy} pts</div>
                  <div><strong>Irregularity:</strong> {breakdown.irregularity} pts</div>
                </div>
              </div>
            </div>
            <div style={{marginTop:12}}>
              <button onClick={() => setShowHealthInfo(s => !s)}>{showHealthInfo ? 'Hide' : 'What is this?'}</button>
              {showHealthInfo && (
                <div style={{marginTop:10,color:'#bbb',fontSize:13}}>
                  <strong>Heart Health Index</strong> combines heart rate (BPM) and rhythm irregularity (variability of inter-beat intervals) into a simple score:
                  <ul>
                    <li>Low HR (bradycardia) and very high HR (tachycardia) increase the score (worse).</li>
                    <li>High beat-to-beat variability (irregular rhythm) increases the score.</li>
                    <li>Categories: Normal &middot; Moderate &middot; High. This is a screening aid only, not diagnostic.</li>
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Clinical Information */}
      <div style={{marginTop:24,background:'#0a0a0a',padding:20,border:'1px solid #1a1a1a'}}>
        <div style={{flex:1}}>
          <h3 style={{margin:0,color:'#fff',fontSize:14,fontWeight:700,marginBottom:12,fontFamily:'monospace',letterSpacing:'2px'}}>
            CLINICAL INFORMATION
          </h3>
          <div style={{color:'#888',fontSize:12,lineHeight:1.8,fontFamily:'monospace'}}>
            <div style={{marginBottom:8}}>
              <strong style={{color:'#aaa'}}>CONNECTION:</strong> Arduino device (115200 baud) via Web Serial API (Chrome/Edge required).
            </div>
            <div style={{marginBottom:8}}>
              <strong style={{color:'#aaa'}}>PAPER SPEED:</strong> 25mm/s (standard ECG recording speed)
            </div>
            <div style={{marginBottom:8}}>
              <strong style={{color:'#aaa'}}>HEALTH INDEX:</strong> Screening tool combining heart rate and rhythm irregularity analysis.
            </div>
            <div style={{padding:12,background:'#1a0000',borderLeft:'3px solid #ff0000',marginTop:12}}>
              <strong style={{color:'#ff6666'}}>CLINICAL WARNING:</strong> This device is for monitoring purposes only. Irregular patterns or abnormal scores require immediate medical consultation for proper diagnosis.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
