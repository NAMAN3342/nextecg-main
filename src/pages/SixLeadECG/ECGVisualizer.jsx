import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { 
  listPairedDevices, 
  isBluetoothEnabled, 
  enableBluetooth,
  ensureBtPermissions,
  connectHC05, 
  startReading, 
  stopReading, 
  disconnect as bluetoothDisconnect,
  isConnected as isBluetoothConnected 
} from '../../bluetooth'

// Detect if running in Capacitor (Android/iOS)
const isCapacitor = typeof window !== 'undefined' && window.Capacitor !== undefined

export default function ECGVisualizer(){
  const navigate = useNavigate()
  // Defaults and constants
  const DEFAULT_SAMPLE_RATE = 125
  const DEFAULT_PAPER_SPEED = 25 // mm/s
  const DEFAULT_MM_PER_MV = 10 // mm per mV
  const DEFAULT_PIXELS_PER_MM = 3
  const DEFAULT_SECONDS = 5
  const CAPTURE_SECONDS = 15 // automatic report duration (seconds)
  const WAIT_SECONDS = 10 // wait time after capture before report ready
  const ADC_MAX = 1023
  const VREF = 5.0

  const [connected, setConnected] = useState(false)
  const [gain, setGain] = useState(1.0)
  const [sampleRate, setSampleRate] = useState(DEFAULT_SAMPLE_RATE)
  const [isCalibrating, setIsCalibrating] = useState(false)
  const [pixelsPerMm, setPixelsPerMm] = useState(DEFAULT_PIXELS_PER_MM)
  const [secondsWindow, setSecondsWindow] = useState(DEFAULT_SECONDS)
  const [inputUnits, setInputUnits] = useState('mv') // 'mv' | 'adc'
  const [filterOn, setFilterOn] = useState(true) // DSP bandpass (0.5–40 Hz)
  const [advancedReport, setAdvancedReport] = useState(true)
  
  // HRV and Heart Rate Analysis State
  const [heartRate, setHeartRate] = useState(0)
  const [hrvMetrics, setHrvMetrics] = useState({ 
    sdnn: 0, rmssd: 0, pnn50: 0, pnn20: 0,
    meanRR: 0, minHR: 0, maxHR: 0,
    triangularIndex: 0, // Geometric HRV
    lfPower: 0, hfPower: 0, lfHfRatio: 0, // Frequency domain
    stressIndex: 0, // Baevsky's stress index
    respiratoryRate: 0 // Derived from HF peak
  })
  const [hrvStatus, setHrvStatus] = useState('normal') // 'low', 'normal', 'high', 'athletic'
  const rrIntervalsRef = useRef([])
  const lastRPeakRef = useRef(null)
  const rPeakThresholdRef = useRef(0.5) // Adaptive R-peak threshold
  const rPeakCooldownRef = useRef(0) // Refractory period counter
  const rPeakBufferRef = useRef([]) // Buffer for multi-lead R-peak confirmation
  const sampleCounterRef = useRef(0) // Global sample counter for timing

  // Final Report Recording (15 seconds + 10s wait)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingProgress, setRecordingProgress] = useState(0)
  const [isWaiting, setIsWaiting] = useState(false)
  const [waitProgress, setWaitProgress] = useState(0)
  const [showReport, setShowReport] = useState(false)
  const [recordedData, setRecordedData] = useState(null)
  const [connectError, setConnectError] = useState(null)
  const [whatsappNumber, setWhatsappNumber] = useState('')
  const [showWhatsAppInput, setShowWhatsAppInput] = useState(false)
  
  // Bluetooth (HC-05) state for Capacitor/Android
  const [connectionMode, setConnectionMode] = useState(isCapacitor ? 'bluetooth' : 'serial') // 'serial' | 'bluetooth'
  const [pairedDevices, setPairedDevices] = useState([])
  const [selectedDevice, setSelectedDevice] = useState('')
  const [showDeviceList, setShowDeviceList] = useState(false)
  const bluetoothRunningRef = useRef(false)
  const reportCanvasRef = useRef(null)

  const leads = ['Lead I','Lead II','Lead III','aVR','aVL','aVF']
  // Paired layout: [Lead I, aVL], [Lead II, aVF], [Lead III, aVR]
  const leadPairs = [
    [0, 4], // Lead I (idx 0) + aVL (idx 4)
    [1, 5], // Lead II (idx 1) + aVF (idx 5)
    [2, 3]  // Lead III (idx 2) + aVR (idx 3)
  ]

  // Refs
  const portRef = useRef(null)
  const readerRef = useRef(null)
  const bufferRef = useRef([]) // Float32Array per lead
  const writeIndexRef = useRef(0)
  const runningRef = useRef(false)
  const pairCanvasRefs = useRef([]) // 3 canvases for 3 rows of paired leads
  // DSP filter state per lead (one-pole HP + one-pole LP)
  const hpStateRef = useRef(leads.map(()=>({x1:0,y1:0})))
  const lpStateRef = useRef(leads.map(()=>({y1:0})))
  const hpAlphaRef = useRef(0)
  const lpAlphaRef = useRef(0)
  // Recording via refs to avoid stale closures
  const recordRef = useRef({ active:false, data:null, count:0 })
  const autoStopTriggeredRef = useRef(false)
  const manualStopRef = useRef(false)
  const sampleRateRef = useRef(sampleRate)
  const freezeDisplayRef = useRef(false)
  const frozenBufferRef = useRef(null)

  // (re)initialize buffers when secondsWindow changes
  useEffect(()=>{
    const samples = Math.max(1, Math.floor(sampleRate * secondsWindow))
    bufferRef.current = leads.map(()=>new Float32Array(samples))
    writeIndexRef.current = 0
  },[secondsWindow, sampleRate])

  // Size helper to keep canvas attributes in sync with settings
  function sizeAllCanvases(){
    const samples = bufferRef.current[0]?.length || Math.max(1, Math.floor(sampleRate * secondsWindow))
    const mmPerSample = DEFAULT_PAPER_SPEED / sampleRate
    const width = Math.max(800, Math.floor(samples * pixelsPerMm * mmPerSample))
    for (let i=0; i<leadPairs.length; i++){
      const el = pairCanvasRefs.current[i]
      if(!el) continue
      el.width = width
      el.height = 100 // Height for one row with 2 leads side by side
    }
  }

  // Ensure canvas dimensions track settings
  useEffect(()=>{ sizeAllCanvases() },[pixelsPerMm, secondsWindow])

  // keep sampleRate in a ref for use inside serial loop
  useEffect(()=>{ sampleRateRef.current = sampleRate },[sampleRate])

  // Recompute filter coefficients when sampleRate changes
  useEffect(()=>{
    const dt = 1/Math.max(1, sampleRateRef.current)
    // High-pass ~0.5 Hz
    const hpFc = 0.5
    const hpRc = 1/(2*Math.PI*hpFc)
    hpAlphaRef.current = hpRc/(hpRc + dt)
    // Low-pass ~40 Hz
    const lpFc = 40
    const lpRc = 1/(2*Math.PI*lpFc)
    lpAlphaRef.current = dt/(lpRc + dt)
    // reset states when rate changes
    hpStateRef.current = leads.map(()=>({x1:0,y1:0}))
    lpStateRef.current = leads.map(()=>({y1:0}))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[sampleRate])

  // Convert incoming value to mV (heuristic)
  function valueToMv(v){
    if (typeof v !== 'number' || isNaN(v)) return 0
    if (inputUnits === 'adc'){
      // Treat v as raw ADC counts (0..1023) and convert to mV using VREF
      const volts = (v * VREF) / ADC_MAX
      return volts * 1000
    }
    // inputUnits === 'mv': already in millivolts
    return v
  }

  // R-peak detection and HRV calculation using 6-lead analysis
  // Uses real timestamps for accurate heart rate calculation
  function detectRPeakMultiLead(mvs) {
    const now = Date.now() // Use real timestamp in ms
    
    // Refractory period: minimum 300ms between R-peaks (200 BPM max)
    if (lastRPeakRef.current !== null && (now - lastRPeakRef.current) < 300) {
      return
    }
    
    // Use Lead II primarily (best for R-peak detection in standard ECG)
    const leadII = mvs[1] || 0
    const leadI = mvs[0] || 0
    const leadIII = mvs[2] || 0
    
    // Use Lead II as primary signal (it shows the largest R-wave typically)
    const primarySignal = leadII
    
    // Store in circular buffer for peak detection
    rPeakBufferRef.current.push({ 
      signal: primarySignal, 
      absSignal: Math.abs(primarySignal),
      time: now 
    })
    
    // Keep buffer at 15 samples (~120ms at 125Hz)
    while (rPeakBufferRef.current.length > 15) {
      rPeakBufferRef.current.shift()
    }
    
    // Need at least 9 samples for reliable peak detection
    if (rPeakBufferRef.current.length < 9) return
    
    const buf = rPeakBufferRef.current
    const len = buf.length
    const midIdx = Math.floor(len / 2) // Check middle sample
    const midSample = buf[midIdx]
    
    // Calculate adaptive threshold from recent signal amplitude
    const recentAbsSignals = buf.map(b => b.absSignal)
    const maxAbs = Math.max(...recentAbsSignals)
    const avgAbs = recentAbsSignals.reduce((a, b) => a + b, 0) / recentAbsSignals.length
    
    // Dynamic threshold: 50% of max or 2x average, whichever is higher, minimum 0.15mV
    const threshold = Math.max(0.15, maxAbs * 0.5, avgAbs * 2)
    
    // Check if midSample is a local maximum (the R-peak)
    // Must be higher than all neighbors within ±3 samples
    let isLocalMax = true
    for (let i = midIdx - 3; i <= midIdx + 3; i++) {
      if (i !== midIdx && i >= 0 && i < len) {
        if (buf[i].signal >= midSample.signal) {
          isLocalMax = false
          break
        }
      }
    }
    
    // For inverted leads, also check if it's a local minimum with large magnitude
    let isLocalMin = true
    for (let i = midIdx - 3; i <= midIdx + 3; i++) {
      if (i !== midIdx && i >= 0 && i < len) {
        if (buf[i].signal <= midSample.signal) {
          isLocalMin = false
          break
        }
      }
    }
    
    const isPeak = (isLocalMax || (isLocalMin && midSample.signal < -threshold)) && 
                   midSample.absSignal > threshold
    
    if (isPeak) {
      const peakTime = midSample.time
      
      if (lastRPeakRef.current !== null) {
        const rrInterval = peakTime - lastRPeakRef.current // Already in ms
        
        // Filter physiologically plausible RR intervals (333-1500ms = 40-180 BPM)
        if (rrInterval >= 333 && rrInterval <= 1500) {
          
          // Ectopic beat rejection
          const recentRR = rrIntervalsRef.current.slice(-8)
          let acceptBeat = true
          
          if (recentRR.length >= 3) {
            const avgRecentRR = recentRR.reduce((a, b) => a + b, 0) / recentRR.length
            // Reject if RR differs by more than 30% from recent average
            const deviation = Math.abs(rrInterval - avgRecentRR) / avgRecentRR
            if (deviation > 0.30) {
              acceptBeat = false
            }
          }
          
          if (acceptBeat) {
            rrIntervalsRef.current.push(rrInterval)
            
            // Keep last 60 RR intervals (~1 min at 60 BPM)
            while (rrIntervalsRef.current.length > 60) {
              rrIntervalsRef.current.shift()
            }
            
            // Calculate instantaneous heart rate
            const instantHR = Math.round(60000 / rrInterval)
            
            // Calculate smoothed heart rate from recent intervals
            if (rrIntervalsRef.current.length >= 2) {
              const recentRRSlice = rrIntervalsRef.current.slice(-4)
              const avgRR = recentRRSlice.reduce((a, b) => a + b, 0) / recentRRSlice.length
              const smoothedHR = Math.round(60000 / avgRR)
              
              if (smoothedHR >= 40 && smoothedHR <= 180) {
                setHeartRate(smoothedHR)
              }
            }
            
            // Calculate HRV metrics when we have enough data
            if (rrIntervalsRef.current.length >= 5) {
              calculateAdvancedHRV()
            }
          }
        }
      }
      
      lastRPeakRef.current = peakTime
    }
  }

  // Legacy single-lead function for backward compatibility
  function detectRPeak(mv) {
    detectRPeakMultiLead([mv, mv, mv * 0.8, -mv * 0.5, mv * 0.5, mv * 0.5])
  }

  function calculateAdvancedHRV() {
    const rr = rrIntervalsRef.current
    if (rr.length < 3) return
    
    // === TIME DOMAIN METRICS ===
    
    // Mean RR interval
    const meanRR = rr.reduce((a, b) => a + b, 0) / rr.length
    
    // SDNN - Standard deviation of NN intervals (overall HRV)
    const squaredDiffs = rr.map(val => Math.pow(val - meanRR, 2))
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / rr.length
    const sdnn = Math.sqrt(variance)
    
    // RMSSD - Root mean square of successive differences (parasympathetic activity)
    let sumSquaredDiffs = 0
    for (let i = 1; i < rr.length; i++) {
      sumSquaredDiffs += Math.pow(rr[i] - rr[i-1], 2)
    }
    const rmssd = Math.sqrt(sumSquaredDiffs / (rr.length - 1))
    
    // pNN50 - Percentage of successive RR intervals differing by >50ms
    let nn50Count = 0
    for (let i = 1; i < rr.length; i++) {
      if (Math.abs(rr[i] - rr[i-1]) > 50) nn50Count++
    }
    const pnn50 = rr.length > 1 ? (nn50Count / (rr.length - 1)) * 100 : 0
    
    // pNN20 - More sensitive measure for short recordings
    let nn20Count = 0
    for (let i = 1; i < rr.length; i++) {
      if (Math.abs(rr[i] - rr[i-1]) > 20) nn20Count++
    }
    const pnn20 = rr.length > 1 ? (nn20Count / (rr.length - 1)) * 100 : 0
    
    // Min/Max HR from RR intervals
    const minRR = Math.min(...rr)
    const maxRR = Math.max(...rr)
    const maxHR = Math.round(60000 / minRR)
    const minHR = Math.round(60000 / maxRR)
    
    // === GEOMETRIC METRICS ===
    
    // HRV Triangular Index (simplified - ratio of total beats to mode)
    const binWidth = 31.25 // ms (larger bins for short recordings)
    const histogram = {}
    rr.forEach(interval => {
      const bin = Math.floor(interval / binWidth)
      histogram[bin] = (histogram[bin] || 0) + 1
    })
    const histValues = Object.values(histogram)
    const maxBinCount = histValues.length > 0 ? Math.max(...histValues) : 1
    const triangularIndex = rr.length / Math.max(1, maxBinCount)
    
    // === SIMPLIFIED FREQUENCY DOMAIN ESTIMATES ===
    // For short-term recordings, estimate LF/HF from RMSSD ratio
    // RMSSD correlates well with HF power (parasympathetic)
    
    let lfPower = 0, hfPower = 0, lfHfRatio = 0
    
    if (rr.length >= 10) {
      // HF power estimate based on RMSSD (vagal tone)
      hfPower = Math.round((rmssd * rmssd) / 100) / 10
      
      // LF power estimate based on total variance minus HF
      const totalPower = variance / 100
      lfPower = Math.max(0, Math.round((totalPower - hfPower) * 10) / 10)
      
      lfHfRatio = hfPower > 0.01 ? Math.round((lfPower / hfPower) * 100) / 100 : 0
    }
    
    // === DERIVED METRICS ===
    
    // Simplified Stress Index based on CV (coefficient of variation)
    const cv = (sdnn / meanRR) * 100 // as percentage
    // Lower CV = higher stress (less variability)
    const stressIndex = cv > 0 ? Math.round((10 / cv) * 100) / 10 : 0
    
    // Respiratory Rate estimation from RMSSD
    // Higher RMSSD = stronger RSA = typically normal breathing
    const respiratoryRate = Math.round(12 + Math.min(8, rmssd / 10))
    
    // === HRV STATUS CLASSIFICATION ===
    let status = 'normal'
    if (sdnn < 30 || rmssd < 15) {
      status = 'low' // Low HRV
    } else if (sdnn > 80 && rmssd > 40) {
      status = 'athletic' // High HRV - good fitness
    } else if (sdnn > 50 && rmssd > 25) {
      status = 'high' // Above average
    }
    
    setHrvStatus(status)
    setHrvMetrics({
      sdnn: Math.round(sdnn * 10) / 10,
      rmssd: Math.round(rmssd * 10) / 10,
      pnn50: Math.round(pnn50 * 10) / 10,
      pnn20: Math.round(pnn20 * 10) / 10,
      meanRR: Math.round(meanRR),
      minHR,
      maxHR,
      triangularIndex: Math.round(triangularIndex * 10) / 10,
      lfPower,
      hfPower,
      lfHfRatio,
      stressIndex,
      respiratoryRate
    })
  }
  
  // Helper: Moving average filter
  function movingAverageFilter(data, windowSize) {
    if (windowSize < 1) windowSize = 1
    const result = []
    for (let i = 0; i < data.length; i++) {
      const start = Math.max(0, i - Math.floor(windowSize / 2))
      const end = Math.min(data.length, i + Math.ceil(windowSize / 2))
      const window = data.slice(start, end)
      result.push(window.reduce((a, b) => a + b, 0) / window.length)
    }
    return result
  }
  
  // Helper: Calculate variance
  function calculateVariance(data) {
    if (data.length < 2) return 0
    const mean = data.reduce((a, b) => a + b, 0) / data.length
    return data.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / data.length
  }

  // Legacy function for backward compatibility
  function calculateHRV() {
    calculateAdvancedHRV()
  }

  function drawGrid(ctx, width, height, pixelsPerMm){
    // Medical-grade ECG paper appearance - cream/white background with red grid
    ctx.fillStyle = '#fefdfb'
    ctx.fillRect(0,0,width,height)
    const px = pixelsPerMm
    // Minor 1mm grid - light red/pink
    ctx.strokeStyle = 'rgba(255, 180, 180, 0.6)'
    ctx.lineWidth = 0.5
    for(let x=0;x<=width;x+=px){ctx.beginPath();ctx.moveTo(x+0.5,0);ctx.lineTo(x+0.5,height);ctx.stroke()}
    for(let y=0;y<=height;y+=px){ctx.beginPath();ctx.moveTo(0,y+0.5);ctx.lineTo(width,y+0.5);ctx.stroke()}
    // Major 5mm grid - darker red
    ctx.strokeStyle = 'rgba(220, 80, 80, 0.8)'
    ctx.lineWidth = 1.0
    for(let x=0;x<=width;x+=px*5){ctx.beginPath();ctx.moveTo(x+0.5,0);ctx.lineTo(x+0.5,height);ctx.stroke()}
    for(let y=0;y<=height;y+=px*5){ctx.beginPath();ctx.moveTo(0,y+0.5);ctx.lineTo(width,y+0.5);ctx.stroke()}
  }

  function drawAll(){
    const samples = bufferRef.current[0]?.length || 1
    const mmPerSample = DEFAULT_PAPER_SPEED / sampleRate
    const xStep = pixelsPerMm * mmPerSample

    // Draw each row with paired leads side by side
    for(let rowIdx=0; rowIdx<leadPairs.length; rowIdx++){
      const canvas = pairCanvasRefs.current[rowIdx]
      if(!canvas) continue
      const ctx = canvas.getContext('2d')
      const w = canvas.width
      const h = canvas.height

      drawGrid(ctx,w,h,pixelsPerMm)

      const [leftLeadIdx, rightLeadIdx] = leadPairs[rowIdx]
      const halfW = w / 2
      
      // If display is frozen, draw from frozenBuffer snapshot; otherwise draw from live ring buffer
      if (freezeDisplayRef.current && frozenBufferRef.current) {
        const frozen = frozenBufferRef.current
        drawLeadTrace(ctx, leftLeadIdx, 0, halfW, h, samples, xStep, leads[leftLeadIdx], frozen[leftLeadIdx])
        drawLeadTrace(ctx, rightLeadIdx, halfW, halfW, h, samples, xStep, leads[rightLeadIdx], frozen[rightLeadIdx])
      } else {
        // Draw left lead (e.g., Lead I)
        drawLeadTrace(ctx, leftLeadIdx, 0, halfW, h, samples, xStep, leads[leftLeadIdx])
        
        // Draw right lead (e.g., aVL)
        drawLeadTrace(ctx, rightLeadIdx, halfW, halfW, h, samples, xStep, leads[rightLeadIdx])
      }
    }
  }

  // samplesArr is an optional plain array used when drawing a frozen snapshot.
  function drawLeadTrace(ctx, leadIdx, xOffset, width, height, samples, xStep, leadName, samplesArr){
    const baselineY = Math.floor(height/2)
    
    // midline - subtle gray for medical appearance
    ctx.strokeStyle='rgba(180, 180, 180, 0.4)'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    ctx.moveTo(xOffset, baselineY+0.5)
    ctx.lineTo(xOffset + width, baselineY+0.5)
    ctx.stroke()

    // calibration pulse (1 mV, 200 ms) at left - medical black
    const calHeightPx = 10 * pixelsPerMm // 10 mm = 1 mV
    const calWidthPx = 5 * pixelsPerMm   // 5 mm = 0.2 s at 25 mm/s
    const calX = xOffset + 8
    ctx.strokeStyle = '#1a1a1a'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(calX, baselineY)
    ctx.lineTo(calX, baselineY - calHeightPx)
    ctx.lineTo(calX + calWidthPx, baselineY - calHeightPx)
    ctx.lineTo(calX + calWidthPx, baselineY)
    ctx.stroke()

    // Lead label - medical-grade dark text
    ctx.fillStyle = '#1a1a1a'
    ctx.font = 'bold 12px "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif'
    ctx.fillText(leadName, calX + calWidthPx + 6, 14)

    // waveform - medical black, no glow effects
    ctx.lineWidth = 1.8
    ctx.strokeStyle = '#1a1a1a'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    let x = xOffset
    if (samplesArr && Array.isArray(samplesArr)){
      // draw from frozen array sequentially
      for (let s=0; s<samplesArr.length; s++){
        const mv = samplesArr[s] || 0
        const mm = mv * DEFAULT_MM_PER_MV * gain
        const y = baselineY - mm * pixelsPerMm
        if (s===0) ctx.moveTo(x,y)
        else ctx.lineTo(x,y)
        x += xStep
        if (x > xOffset + width + 2) break
      }
    } else {
      // live ring buffer draw
      for(let s=0;s<samples;s++){
        const idx = (writeIndexRef.current + s) % samples
        const mv = bufferRef.current[leadIdx][idx] || 0
        const mm = mv * DEFAULT_MM_PER_MV * gain
        const y = baselineY - mm * pixelsPerMm
        if(s===0) ctx.moveTo(x,y)
        else ctx.lineTo(x,y)
        x += xStep
        if (x > xOffset + width + 2) break
      }
    }
    ctx.stroke()
  }

  // One-pole high-pass followed by one-pole low-pass per-lead
  function filterSample(leadIdx, x){
    // high-pass: y[n] = a*(y[n-1] + x[n] - x[n-1])
    const aHP = hpAlphaRef.current
    const stHP = hpStateRef.current[leadIdx]
    const yHP = aHP * (stHP.y1 + x - stHP.x1)
    stHP.x1 = x
    stHP.y1 = yHP
    // low-pass: y[n] = y[n-1] + a*(x - y[n-1]) with x=yHP
    const aLP = lpAlphaRef.current
    const stLP = lpStateRef.current[leadIdx]
    const y = stLP.y1 + aLP * (yHP - stLP.y1)
    stLP.y1 = y
    return y
  }

  // animation - always run so live ECG continues while report modal is open
  useEffect(()=>{
    let raf = null
    function tick(){ drawAll(); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return ()=>{ if(raf) cancelAnimationFrame(raf) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pixelsPerMm,secondsWindow,gain])

  // Draw report to a given canvas (shared by modal and export)
  function drawReportPage(canvas, data) {
    const ctx = canvas.getContext('2d')
    const ppm = 6 // pixels per mm - realistic ECG paper resolution
    const paperWidth = 280 // mm - standard ECG strip width
    const paperHeight = 200 // mm - realistic height for 6 leads
    canvas.width = paperWidth * ppm
    canvas.height = paperHeight * ppm

    // Background
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // Grid - standard ECG paper (1mm minor, 5mm major)
    // Minor 1mm grid
    ctx.strokeStyle = 'rgba(255, 100, 100, 0.5)'
    ctx.lineWidth = 1
    for (let x = 0; x <= canvas.width; x += ppm) { 
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke() 
    }
    for (let y = 0; y <= canvas.height; y += ppm) { 
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke() 
    }
    // Major 5mm grid (0.5 second at 25mm/s, 0.5mV at 10mm/mV)
    ctx.strokeStyle = 'rgba(220,38,38,0.9)'
    ctx.lineWidth = 2
    for (let x = 0; x <= canvas.width; x += ppm*5) { 
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,canvas.height); ctx.stroke() 
    }
    for (let y = 0; y <= canvas.height; y += ppm*5) { 
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(canvas.width,y); ctx.stroke() 
    }

    const marginMm = 8
    const margin = marginMm * ppm
    const headerMm = 28
    const headerH = headerMm * ppm

    // Header with comprehensive info
    ctx.fillStyle = '#000'
    ctx.font = 'bold 18px Arial, Helvetica, sans-serif'
  const firstLead = data['Lead I'] || data['I'] || data['Lead II'] || data['II'] || data['Lead III'] || data['III']
  const recordedSeconds = firstLead ? (firstLead.length / sampleRate).toFixed(1) : '0.0'
  // If metadata exists, show that this is a 1s excerpt at the 15s mark (or other capture time)
  const meta = data && data.__meta ? data.__meta : null
  const headerTitle = meta && meta.excerptSeconds && meta.captureAt ? `NextECG — 6-Lead ECG Report (excerpt ${meta.excerptSeconds}s at ${meta.captureAt}s)` : `NextECG — 6-Lead ECG Report (${recordedSeconds}s)`
  ctx.fillText(headerTitle, margin, margin + 14)
    
    ctx.font = '12px Arial, Helvetica, sans-serif'
    const dateStr = new Date().toLocaleString()
    ctx.fillText(`Date: ${dateStr}`, margin, margin + 30)
    
  // Technical parameters
  ctx.fillText(`Time Domain: 25 mm/s  |  Amplitude: 10 mm/mV  |  Sample Rate: ${sampleRate} Hz`, margin, margin + 44)
  const recordingLabelSeconds = meta && meta.excerptSeconds ? `${meta.excerptSeconds}` : recordedSeconds
  ctx.fillText(`Frequency Domain: Filter 0.5–40 Hz (Bandpass)  |  Recording: ${recordingLabelSeconds} seconds`, margin, margin + 58)

    // Calibration pulse 1mV
    const calX = margin
    const calY = margin + headerH - (12*ppm)
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(calX, calY)
    ctx.lineTo(calX, calY + 10*ppm)
    ctx.lineTo(calX + 5*ppm, calY + 10*ppm)
    ctx.lineTo(calX + 5*ppm, calY)
    ctx.stroke()
    ctx.fillText('1mV', calX + 6*ppm, calY + 6*ppm)

    // Seconds markers across header
    const sampleLead = data['I'] || data['II'] || data['III'] || data['aVR'] || data['aVL'] || data['aVF']
    const totalSeconds = sampleLead ? sampleLead.length / sampleRate : 10
    const secondsToShow = Math.ceil(totalSeconds)
    ctx.strokeStyle = '#000'
    ctx.lineWidth = 1.5
    ctx.font = '12px Arial, Helvetica, sans-serif'
    for (let s=0; s<=secondsToShow; s++){
      const x = margin + s * 25 * ppm
      ctx.beginPath(); ctx.moveTo(x, margin + headerH - 20); ctx.lineTo(x, margin + headerH - 10); ctx.stroke()
      ctx.fillText(`${s}s`, x + 3, margin + headerH - 14)
    }

    // Normalize/ensure leads: prefer 'Lead I' keys but accept multiple variants.
    const shortKeys = ['I', 'II', 'III', 'aVR', 'aVL', 'aVF']
    const longLabels = ['Lead I','Lead II','Lead III','aVR','aVL','aVF']
    // Build normalized map
    const norm = {}
    function findSamples(variants){ for (const v of variants){ if (data && data[v]) return data[v] } return null }
    for (let i=0;i<shortKeys.length;i++){
      const short = shortKeys[i]
      const long = longLabels[i]
      norm[short] = findSamples([long, short, `Lead ${short}`])
    }
    // Derive missing leads if requested
    if (advancedReport) {
      if (!norm['III'] && norm['I'] && norm['II']){
        const a = norm['II'], b = norm['I']; const len = Math.min(a.length, b.length); const arr = new Array(len)
        for (let k=0;k<len;k++) arr[k] = a[k] - b[k]
        norm['III'] = arr
      }
      if ((!norm['aVR'] || !norm['aVL'] || !norm['aVF']) && norm['I'] && norm['II']){
        const I = norm['I'], II = norm['II']; const len = Math.min(I.length, II.length)
        const avr = new Array(len), avl = new Array(len), avf = new Array(len)
        for (let k=0;k<len;k++){ const la=I[k], ll=II[k], ra=0.0; avr[k]=ra-(la+ll)/2; avl[k]=la-(ra+ll)/2; avf[k]=ll-(ra+la)/2 }
        if (!norm['aVR']) norm['aVR']=avr
        if (!norm['aVL']) norm['aVL']=avl
        if (!norm['aVF']) norm['aVF']=avf
      }
    }
    const leadHeightMm = 26
    const leadHeight = leadHeightMm * ppm
    const startY = margin + headerH + 5
    const innerWidth = canvas.width - 2*margin

    // draw paired rows: [Lead I | aVL], [Lead II | aVF], [Lead III | aVR]
    const pairList = [[0,4],[1,5],[2,3]]
    const gapMm = 6
    const gapPx = gapMm * ppm
    const colWidth = Math.floor((innerWidth - gapPx) / 2)
    for (let row=0; row<pairList.length; row++){
      const [leftIdx, rightIdx] = pairList[row]
      const leftShort = shortKeys[leftIdx]
      const rightShort = shortKeys[rightIdx]
      const leftLabel = longLabels[leftIdx]
      const rightLabel = longLabels[rightIdx]
      const yBase = startY + row * leadHeight + (leadHeight/2)
      const leftX = margin
      const rightX = margin + colWidth + gapPx
      drawReportLeadStrip(ctx, norm[leftShort] || null, leftLabel, leftX, yBase, colWidth, ppm)
      drawReportLeadStrip(ctx, norm[rightShort] || null, rightLabel, rightX, yBase, colWidth, ppm)
    }
  }

  // When report is shown, render into the visible canvas
  useEffect(() => {
    if (!showReport || !recordedData || !reportCanvasRef.current) return
    drawReportPage(reportCanvasRef.current, recordedData)
  }, [showReport, recordedData, sampleRate, gain])

  function drawReportLeadStrip(ctx, samples, leadName, xStart, yBase, width, ppm) {
    if (!samples || samples.length === 0) return
    
    // Lead label - BOLD BLACK, proper names
    ctx.fillStyle = '#000000'
    ctx.font = 'bold 16px Arial, Helvetica, sans-serif'
    ctx.fillText(leadName, xStart + 2, yBase - 12)
    
    // Baseline reference
    ctx.strokeStyle = 'rgba(0,0,0,0.15)'
    ctx.lineWidth = 0.8
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(xStart, yBase)
    ctx.lineTo(xStart + width, yBase)
    ctx.stroke()
    ctx.setLineDash([])

    // Per-lead second ticks at baseline (25mm intervals)
    const mmPerSec = 25
    const totalSeconds = samples.length / sampleRate
    const totalWidthMm = totalSeconds * mmPerSec
    const availWidthMm = (width / ppm) - 5
    const timeScale = Math.min(1.0, availWidthMm / totalWidthMm)
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'
    ctx.lineWidth = 1
    for (let s = 0; s <= Math.ceil(totalSeconds); s++){
      const xMm = s * mmPerSec * timeScale
      const x = xStart + (xMm * ppm)
      ctx.beginPath(); ctx.moveTo(x, yBase - 6); ctx.lineTo(x, yBase + 6); ctx.stroke()
    }
    
    // ECG WAVEFORM - THICK BLACK with ANTI-ALIASING
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.shadowColor = 'rgba(0,0,0,0.2)'
    ctx.shadowBlur = 1
    
    ctx.beginPath()
    
  const mmPerSec2 = 25 // standard ECG paper speed
  const totalSeconds2 = samples.length / sampleRate
  const totalWidthMm2 = totalSeconds2 * mmPerSec2 // total width needed in mm
  const availWidthMm2 = (width / ppm) - 5 // available width minus padding
    
  // If recording is longer than available width, compress time scale proportionally
  const timeScale2 = Math.min(1.0, availWidthMm2 / totalWidthMm2)
    
    for (let i = 0; i < samples.length; i++) {
  const timeSec = i / sampleRate
  const xMm = timeSec * mmPerSec2 * timeScale2
      const xPos = xStart + (xMm * ppm)
      
      const mv = samples[i]
      const yMm = mv * DEFAULT_MM_PER_MV * gain // 10mm per mV standard
      const yPos = yBase - (yMm * ppm)
      
      if (i === 0) {
        ctx.moveTo(xPos, yPos)
      } else {
        ctx.lineTo(xPos, yPos)
      }
    }
    ctx.stroke()
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
  }

  // connect via Web Serial
  async function connect(){
    setConnectError(null)
    
    // Reset HRV tracking on new connection
    rrIntervalsRef.current = []
    lastRPeakRef.current = null
    rPeakCooldownRef.current = 0
    rPeakBufferRef.current = []
    sampleCounterRef.current = 0
    setHeartRate(0)
    setHrvMetrics({ 
      sdnn: 0, rmssd: 0, pnn50: 0, pnn20: 0,
      meanRR: 0, minHR: 0, maxHR: 0,
      triangularIndex: 0, lfPower: 0, hfPower: 0, lfHfRatio: 0,
      stressIndex: 0, respiratoryRate: 0
    })
    setHrvStatus('normal')
    
    if(!('serial' in navigator)) { setConnectError('Web Serial API not available in this browser. Use Chrome or Edge.'); alert('Use Chrome or Edge with Web Serial enabled'); return }
    try{
      // Helpful diagnostic: list already-authorized ports
      if (navigator.serial.getPorts) {
        try { const existing = await navigator.serial.getPorts(); console.debug('Previously authorized serial ports:', existing.length) } catch(e){ console.debug('getPorts failed', e) }
      }
      const port = await navigator.serial.requestPort()
      await port.open({ baudRate: 115200 })
      portRef.current = port
      setConnected(true)
      const decoder = new TextDecoderStream()
      port.readable.pipeTo(decoder.writable)
      const reader = decoder.readable.getReader()
      readerRef.current = reader
  runningRef.current = true
  // enter calibration mode on connect; Arduino typically calibrates for ~5s
  setIsCalibrating(true)
  // fallback: turn off calibration after 5s unless device announces completion
  const calibTimeout = setTimeout(()=>{ setIsCalibrating(false) }, 5000)
      let textBuffer = ''

      while(runningRef.current){
        const { value, done } = await reader.read()
        if(done) break
        textBuffer += value
        const lines = textBuffer.split('\n')
        textBuffer = lines.pop() || ''
        for(let line of lines){
          line = line.trim(); if(!line) continue
          // Detect calibration logs from Arduino (case-insensitive)
          const lower = line.toLowerCase()
          if(lower.includes('calibration complete') || lower.includes('calibrated') || lower.includes('calibration done')){
            setIsCalibrating(false)
            clearTimeout(calibTimeout)
            continue
          }
          if(lower.includes('starting') && lower.includes('calibration')){
            setIsCalibrating(true)
            continue
          }
          // Robust parse: accept JSON, 6-value CSV, or 2-value CSV (Lead I, Lead II)
          let arr = null
          let parsedJson = null
          try{ parsedJson = JSON.parse(line) }catch(_e){ parsedJson = null }
          if(parsedJson && typeof parsedJson === 'object'){
            const keys = ['lead1','lead2','lead3','avr','avl','avf']
            if(keys.every(k=>k in parsedJson)){
              arr = keys.map(k=>parseFloat(parsedJson[k]))
            }
          }
          if(!arr){
            const nums = (line.match(/-?\d+(?:\.\d+)?/g) || []).map(v=>parseFloat(v))
            if(nums.length >= 6){
              arr = nums.slice(0,6)
            } else if(nums.length === 2){
              // Build derived leads from Lead I (LA-RA) and Lead II (LL-RA)
              const lead1 = nums[0]
              const lead2 = nums[1]
              const lead3 = lead2 - lead1
              const ra = 0.0, la = lead1, ll = lead2
              const avr = ra - (la + ll)/2
              const avl = la - (ra + ll)/2
              const avf = ll - (ra + la)/2
              arr = [lead1, lead2, lead3, avr, avl, avf]
            }
          }
          if(!arr) continue

          // If we are calibrating, don't write incoming signal samples to the visible buffer.
          // This prevents the frontend from showing unstable signals during the Arduino's auto-cal phase.
          if(isCalibrating){
            continue
          }

          // Convert and optionally filter
          const mvs = arr.map(v => valueToMv(v))
          for(let i=0;i<mvs.length;i++){
            if(filterOn) mvs[i] = filterSample(i, mvs[i])
          }

          // Multi-lead R-peak detection using all 6 leads for accurate HR/HRV
          detectRPeakMultiLead(mvs)

          // Recording for final report (continuous until user stops)
          if (recordRef.current.active && recordRef.current.data) {
            leads.forEach((ln, idx) => {
              recordRef.current.data[ln].push(mvs[idx])
            })
            recordRef.current.count += 1
            // Use timestamp-based duration for robustness
            const nowSec = Date.now()/1000
            const start = recordRef.current.startTime || nowSec
            const duration = nowSec - start
            setRecordingProgress(duration)
            // Auto-stop when we reach CAPTURE_SECONDS seconds (guard to call once)
            if (duration >= CAPTURE_SECONDS && !autoStopTriggeredRef.current) {
              autoStopTriggeredRef.current = true
              try { stopRecording({ auto: true, captureSecond: CAPTURE_SECONDS }) } catch(e){ console.warn('auto-stop failed', e) }
            }
          }

          const samples = bufferRef.current[0]?.length || Math.max(1,Math.floor(sampleRate*secondsWindow))
          for(let i=0;i<mvs.length;i++){
            const mv = mvs[i]
            if(!bufferRef.current[i]) bufferRef.current[i] = new Float32Array(samples)
            bufferRef.current[i][writeIndexRef.current] = mv
          }
          writeIndexRef.current = (writeIndexRef.current + 1) % samples
        }
      }
    }catch(err){
      console.error('Serial connect error', err)
      const msg = err && err.message ? err.message : String(err)
      setConnectError(msg)
      alert('Connection failed: '+msg)
      setConnected(false)
    }
  }

  async function disconnect(){
    runningRef.current = false
    bluetoothRunningRef.current = false
    setConnected(false)
    setIsRecording(false)
    try{
      if(readerRef.current){ await readerRef.current.cancel(); readerRef.current=null }
      if(portRef.current){ await portRef.current.close(); portRef.current=null }
      // Also disconnect Bluetooth if connected
      stopReading()
      await bluetoothDisconnect()
    }catch(e){console.warn(e)}
  }

  // ============ BLUETOOTH (HC-05) CONNECTION FOR CAPACITOR/ANDROID ============
  
  // Load paired Bluetooth devices
  async function loadPairedDevices() {
    try {
      // Request runtime permissions (Android 12+)
      const permsOk = await ensureBtPermissions()
      if (!permsOk) {
        setConnectError('Bluetooth permissions denied. Please grant Bluetooth and Location permissions.')
        return
      }

      let enabled = await isBluetoothEnabled()
      if (!enabled) {
        // Try to prompt enable
        const didEnable = await enableBluetooth()
        enabled = didEnable ? true : await isBluetoothEnabled()
      }
      if (!enabled) {
        setConnectError('Bluetooth is not enabled. Please enable Bluetooth in device settings.')
        return
      }
      const devices = await listPairedDevices()
      setPairedDevices(devices)
      setShowDeviceList(true)
      if (devices.length === 0) {
        setConnectError('No paired Bluetooth devices found. Pair your HC-05 in Settings first.')
      }
    } catch (err) {
      console.error('Failed to list Bluetooth devices:', err)
      setConnectError(err.message || 'Failed to list Bluetooth devices')
    }
  }

  // Connect to HC-05 via Bluetooth
  async function connectBluetooth(mac) {
    setConnectError(null)
    setShowDeviceList(false)
    
    // Reset HRV tracking
    rrIntervalsRef.current = []
    lastRPeakRef.current = null
    rPeakCooldownRef.current = 0
    rPeakBufferRef.current = []
    sampleCounterRef.current = 0
    setHeartRate(0)
    setHrvMetrics({ 
      sdnn: 0, rmssd: 0, pnn50: 0, pnn20: 0,
      meanRR: 0, minHR: 0, maxHR: 0,
      triangularIndex: 0, lfPower: 0, hfPower: 0, lfHfRatio: 0,
      stressIndex: 0, respiratoryRate: 0
    })
    setHrvStatus('normal')
    
    try {
      await connectHC05(mac)
      setConnected(true)
      bluetoothRunningRef.current = true
      setSelectedDevice(mac)
      
      // Enter calibration mode
      setIsCalibrating(true)
      const calibTimeout = setTimeout(() => setIsCalibrating(false), 5000)
      
      // Start reading data from HC-05
      startReading((line) => {
        if (!bluetoothRunningRef.current) return
        
        line = line.trim()
        if (!line) return
        
        // Detect calibration logs
        const lower = line.toLowerCase()
        if (lower.includes('calibration complete') || lower.includes('calibrated') || lower.includes('calibration done')) {
          setIsCalibrating(false)
          clearTimeout(calibTimeout)
          return
        }
        if (lower.includes('starting') && lower.includes('calibration')) {
          setIsCalibrating(true)
          return
        }
        
        // Parse data (same logic as serial)
        let arr = null
        let parsedJson = null
        try { parsedJson = JSON.parse(line) } catch (_e) { parsedJson = null }
        
        if (parsedJson && typeof parsedJson === 'object') {
          const keys = ['lead1', 'lead2', 'lead3', 'avr', 'avl', 'avf']
          if (keys.every(k => k in parsedJson)) {
            arr = keys.map(k => parseFloat(parsedJson[k]))
          }
        }
        
        if (!arr) {
          const nums = (line.match(/-?\d+(?:\.\d+)?/g) || []).map(v => parseFloat(v))
          if (nums.length >= 6) {
            arr = nums.slice(0, 6)
          } else if (nums.length === 2) {
            const lead1 = nums[0]
            const lead2 = nums[1]
            const lead3 = lead2 - lead1
            const ra = 0.0, la = lead1, ll = lead2
            const avr = ra - (la + ll) / 2
            const avl = la - (ra + ll) / 2
            const avf = ll - (ra + la) / 2
            arr = [lead1, lead2, lead3, avr, avl, avf]
          }
        }
        
        if (!arr) return
        if (isCalibrating) return
        
        // Convert and filter
        const mvs = arr.map(v => valueToMv(v))
        for (let i = 0; i < mvs.length; i++) {
          if (filterOn) mvs[i] = filterSample(i, mvs[i])
        }
        
        // R-peak detection
        detectRPeakMultiLead(mvs)
        
        // Recording
        if (recordRef.current.active && recordRef.current.data) {
          leads.forEach((ln, idx) => {
            recordRef.current.data[ln].push(mvs[idx])
          })
          recordRef.current.count += 1
          const nowSec = Date.now() / 1000
          const start = recordRef.current.startTime || nowSec
          const duration = nowSec - start
          setRecordingProgress(duration)
          if (duration >= CAPTURE_SECONDS && !autoStopTriggeredRef.current) {
            autoStopTriggeredRef.current = true
            try { stopRecording({ auto: true, captureSecond: CAPTURE_SECONDS }) } catch (e) { console.warn('auto-stop failed', e) }
          }
        }
        
        // Write to buffer
        const samples = bufferRef.current[0]?.length || Math.max(1, Math.floor(sampleRate * secondsWindow))
        for (let i = 0; i < mvs.length; i++) {
          const mv = mvs[i]
          if (!bufferRef.current[i]) bufferRef.current[i] = new Float32Array(samples)
          bufferRef.current[i][writeIndexRef.current] = mv
        }
        writeIndexRef.current = (writeIndexRef.current + 1) % samples
      })
      
    } catch (err) {
      console.error('Bluetooth connect error:', err)
      const msg = err && err.message ? err.message : String(err)
      setConnectError(msg)
      alert('Bluetooth connection failed: ' + msg)
      setConnected(false)
    }
  }

  // Smart connect: use Bluetooth on Capacitor, Web Serial in browser
  function handleConnect() {
    if (connectionMode === 'bluetooth' || isCapacitor) {
      loadPairedDevices()
    } else {
      connect()
    }
  }

  function startRecording() {
    // Support both Web Serial and Bluetooth connections
    const isSerialConnected = portRef.current !== null
    const isBtConnected = bluetoothRunningRef.current
    
    if ((!isSerialConnected && !isBtConnected) || !connected) {
      alert('Connect to device first!')
      return
    }
    // initialize ref buffers for each lead
    recordRef.current = { active:true, data:{}, count:0, startTime: Date.now()/1000 }
  autoStopTriggeredRef.current = false
  manualStopRef.current = false
    leads.forEach(ln => { recordRef.current.data[ln] = [] })
  // Clear any frozen display so live view resumes and allow incoming data
  frozenBufferRef.current = null
  freezeDisplayRef.current = false
    setRecordingProgress(0)
    setIsRecording(true)
    setShowReport(false)
  }

  function stopRecording(options = { auto: false, captureSecond: CAPTURE_SECONDS }) {
    const { auto, captureSecond } = options
    // If not recording and this isn't a forced auto-stop, ignore
    if (!isRecording && !auto && !recordRef.current.active) return

    // deactivate recording immediately
    recordRef.current.active = false
    setIsRecording(false)

    // Prepare snapshot object
    const snap = {}

    if (auto) {
      // For auto-stop we want the 1-second excerpt that ends at captureSecond (e.g., 14s..15s)
      const oneSecondSamples = Math.floor(1 * sampleRateRef.current)
      const sampleIndexEnd = Math.floor((captureSecond) * sampleRateRef.current)
      leads.forEach(ln => {
        const arr = recordRef.current.data[ln] || []
        // preferred: slice from (end - oneSecondSamples) .. end, but guard against short arrays
        let startIdx = sampleIndexEnd - oneSecondSamples
        if (startIdx < 0) startIdx = 0
        // If we don't yet have samples up to sampleIndexEnd (e.g., timing jitter), fall back to last oneSecondSamples
        if (arr.length >= sampleIndexEnd) {
          snap[ln] = arr.slice(Math.max(0, startIdx), Math.min(sampleIndexEnd, arr.length))
        } else {
          snap[ln] = arr.length > oneSecondSamples ? arr.slice(-oneSecondSamples) : arr.slice()
        }
      })
      // embed metadata so report can label the excerpt correctly
      snap.__meta = { excerptSeconds: 1, captureAt: captureSecond, sampleIndexEnd }
    } else {
      // user-initiated stop: keep entire captured buffer
      leads.forEach(ln => { snap[ln] = (recordRef.current.data[ln] || []).slice() })
      snap.__meta = { excerptSeconds: (snap[leads[0]]?.length || 0) / sampleRateRef.current, captureAt: null }
    }

    // Normalize snap into short keys and long keys and derive missing leads so report is consistent
    const normalized = {}
    // helper to set both short and long labels
    function setLead(short, long, arr){ if(!arr) arr = null; normalized[short] = arr; normalized[long] = arr }

    // populate from snap which uses long labels (e.g., 'Lead I')
    leads.forEach((longLabel, idx) => {
      const short = ['I','II','III','aVR','aVL','aVF'][idx]
      setLead(short, longLabel, snap[longLabel] || snap[short] || snap[`Lead ${short}`])
    })

    // If advancedReport, derive missing leads from I & II
    if (advancedReport) {
      const I = normalized['I']
      const II = normalized['II']
      if ((!normalized['III'] || !normalized['Lead III']) && I && II) {
        const len = Math.min(I.length, II.length)
        const arr = new Array(len)
        for (let k=0;k<len;k++) arr[k] = II[k] - I[k]
        setLead('III','Lead III', arr)
      }
      if ((!normalized['aVR'] || !normalized['aVL'] || !normalized['aVF']) && I && II) {
        const len = Math.min(I.length, II.length)
        const avr = new Array(len), avl = new Array(len), avf = new Array(len)
        for (let k=0;k<len;k++){
          const la = I[k]; const ll = II[k]; const ra = 0.0
          avr[k] = ra - (la + ll)/2
          avl[k] = la - (ra + ll)/2
          avf[k] = ll - (ra + la)/2
        }
        setLead('aVR','aVR', avr)
        setLead('aVL','aVL', avl)
        setLead('aVF','aVF', avf)
      }
    }

  setRecordedData(normalized)

    // If this was a manual stop (not auto), snapshot the current live ring buffer
    // and freeze the on-screen display so the user sees the exact frozen waveform.
    if (!auto) {
      try {
        const samples = bufferRef.current[0]?.length || 1
        const end = writeIndexRef.current
        const snapBuf = bufferRef.current.map(arr => {
          const out = new Array(samples)
          for (let s = 0; s < samples; s++) {
            const idx = (end + s) % samples
            out[s] = arr[idx]
          }
          return out
        })
        frozenBufferRef.current = snapBuf
        freezeDisplayRef.current = true
        console.debug('stopRecording: froze display snapshot (manual stop)', { samples, end })
      } catch (e) {
        console.warn('stopRecording: failed to create frozen snapshot', e)
        frozenBufferRef.current = null
        freezeDisplayRef.current = false
      }
      // mark manual stop so auto-start won't run
      manualStopRef.current = true
    } else {
      // For auto-stops we do not freeze the live display by default
      frozenBufferRef.current = null
      freezeDisplayRef.current = false
    }

    // Start wait period (processing)
    setIsWaiting(true)
    setWaitProgress(0)
  }

  // Countdown timer for 10-second wait after recording
  useEffect(() => {
    if (!isWaiting) return
    
    let elapsed = 0
    const interval = setInterval(() => {
      elapsed += 0.1
      setWaitProgress(elapsed)
      
      if (elapsed >= WAIT_SECONDS) {
        clearInterval(interval)
        setIsWaiting(false)
        setWaitProgress(0)
          // Report is now ready - user may open it via the 'View Report' button (no auto-popup)
      }
    }, 100)
    
    return () => clearInterval(interval)
  }, [isWaiting])

  // Auto-start capture after calibration completes
  useEffect(() => {
    if (connected && !isCalibrating && !isRecording && !showReport && !isWaiting && !manualStopRef.current) {
      const timer = setTimeout(() => {
        startRecording()
      }, 500) // Small delay to ensure calibration state is stable
      return () => clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, isCalibrating, isRecording, showReport, isWaiting])

  function downloadReport() {
    if (reportCanvasRef.current) {
      const link = document.createElement('a')
      link.download = 'ecg-report-15sec.png'
      link.href = reportCanvasRef.current.toDataURL()
      link.click()
    }
  }

  // Share report to WhatsApp with comprehensive HRV data
  async function shareToWhatsApp() {
    if (!reportCanvasRef.current) {
      alert('No report available to share')
      return
    }

    try {
      // Convert canvas to blob
      const canvas = reportCanvasRef.current
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      
      if (!blob) {
        throw new Error('Failed to create image')
      }

      // Create file from blob
      const file = new File([blob], 'ECG-Report.png', { type: 'image/png' })
      
      // Prepare comprehensive share data with full HRV metrics
      const dateStr = new Date().toLocaleString()
      const hrvStatusText = hrvStatus === 'low' ? '⚠️ Low' : hrvStatus === 'athletic' ? '💪 Athletic' : hrvStatus === 'high' ? '✓ Excellent' : '● Normal'
      
      const shareText = `📊 NextECG 6-Lead Report\n━━━━━━━━━━━━━━━━━━\n📅 ${dateStr}\n\n❤️ *HEART RATE*\n• Current: ${heartRate} BPM\n• Range: ${hrvMetrics.minHR}-${hrvMetrics.maxHR} BPM\n\n📈 *HRV ANALYSIS*\n• Status: ${hrvStatusText}\n• SDNN: ${hrvMetrics.sdnn} ms\n• RMSSD: ${hrvMetrics.rmssd} ms\n• pNN50: ${hrvMetrics.pnn50}%\n\n🔬 *FREQUENCY DOMAIN*\n• LF Power: ${hrvMetrics.lfPower}\n• HF Power: ${hrvMetrics.hfPower}\n• LF/HF Ratio: ${hrvMetrics.lfHfRatio}\n\n😰 Stress Index: ${hrvMetrics.stressIndex}\n🫁 Respiratory Rate: ${hrvMetrics.respiratoryRate}/min\n\n⚠️ For medical review only`

      // Check if Web Share API is available with file sharing
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: 'ECG Report - NextECG',
          text: shareText,
          files: [file]
        })
      } else {
        // Fallback: Download the file and open WhatsApp with message
        // First download the image
        const link = document.createElement('a')
        link.download = 'ECG-Report.png'
        link.href = canvas.toDataURL('image/png')
        link.click()

        // Then open WhatsApp with the message (user needs to attach image manually)
        const whatsappMessage = encodeURIComponent(
          `📊 *NextECG 6-Lead Report*\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `📅 ${dateStr}\n\n` +
          `❤️ *HEART RATE*\n` +
          `• Current: ${heartRate} BPM\n` +
          `• Range: ${hrvMetrics.minHR}-${hrvMetrics.maxHR} BPM\n\n` +
          `📈 *HRV ANALYSIS*\n` +
          `• Status: ${hrvStatusText}\n` +
          `• SDNN: ${hrvMetrics.sdnn} ms\n` +
          `• RMSSD: ${hrvMetrics.rmssd} ms\n` +
          `• pNN50: ${hrvMetrics.pnn50}%\n` +
          `• Mean RR: ${hrvMetrics.meanRR} ms\n\n` +
          `🔬 *FREQUENCY DOMAIN*\n` +
          `• LF Power: ${hrvMetrics.lfPower}\n` +
          `• HF Power: ${hrvMetrics.hfPower}\n` +
          `• LF/HF: ${hrvMetrics.lfHfRatio}\n\n` +
          `😰 Stress Index: ${hrvMetrics.stressIndex}\n` +
          `🫁 Respiratory Rate: ${hrvMetrics.respiratoryRate}/min\n\n` +
          `📎 _Attach ECG-Report.png_\n\n` +
          `⚠️ For medical review only`
        )
        
        // Open WhatsApp Web (works on desktop) or WhatsApp app (works on mobile)
        const whatsappURL = `https://wa.me/?text=${whatsappMessage}`
        window.open(whatsappURL, '_blank')
        
        alert('📱 ECG Report downloaded!\n\nWhatsApp will open in a new tab.\nPlease attach the downloaded image to your message.')
      }
    } catch (error) {
      console.error('Share failed:', error)
      if (error.name !== 'AbortError') {
        alert('Share failed: ' + error.message)
      }
    }
  }

  // Share to specific WhatsApp number with comprehensive HRV data
  async function shareToWhatsAppNumber(phoneNumber) {
    if (!reportCanvasRef.current) {
      alert('No report available to share')
      return
    }

    const canvas = reportCanvasRef.current
    const dateStr = new Date().toLocaleString()
    const hrvStatusText = hrvStatus === 'low' ? '⚠️ Low' : hrvStatus === 'athletic' ? '💪 Athletic' : hrvStatus === 'high' ? '✓ Excellent' : '● Normal'
    
    // Download the image first
    const link = document.createElement('a')
    link.download = 'ECG-Report.png'
    link.href = canvas.toDataURL('image/png')
    link.click()

    const whatsappMessage = encodeURIComponent(
      `📊 *NextECG 6-Lead Report*\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `📅 ${dateStr}\n\n` +
      `❤️ *HEART RATE*\n` +
      `• Current: ${heartRate} BPM\n` +
      `• Range: ${hrvMetrics.minHR}-${hrvMetrics.maxHR} BPM\n\n` +
      `📈 *HRV ANALYSIS*\n` +
      `• Status: ${hrvStatusText}\n` +
      `• SDNN: ${hrvMetrics.sdnn} ms\n` +
      `• RMSSD: ${hrvMetrics.rmssd} ms\n` +
      `• pNN50: ${hrvMetrics.pnn50}%\n\n` +
      `🔬 *FREQUENCY DOMAIN*\n` +
      `• LF/HF: ${hrvMetrics.lfHfRatio}\n\n` +
      `😰 Stress Index: ${hrvMetrics.stressIndex}\n\n` +
      `📎 _Attach ECG-Report.png_\n\n` +
      `⚠️ For medical review only`
    )
    
    // Clean phone number (remove spaces, dashes, etc.)
    const cleanNumber = phoneNumber.replace(/[^0-9+]/g, '')
    const whatsappURL = `https://wa.me/${cleanNumber}?text=${whatsappMessage}`
    window.open(whatsappURL, '_blank')
  }

  // export PNG - paired leads layout
  function exportPNG(){
    const cvsList = pairCanvasRefs.current.filter(Boolean)
    if(!cvsList.length) return
    const totalW = cvsList[0].width
    const totalH = cvsList.reduce((s,c)=>s+c.height,0)
    const out = document.createElement('canvas')
    out.width = totalW; out.height = totalH
    const ctx = out.getContext('2d')
    let y = 0
    for(let c of cvsList){ ctx.drawImage(c,0,y); y += c.height }
    const url = out.toDataURL('image/png')
    const a = document.createElement('a'); a.href = url; a.download = 'ecg_export.png'; a.click()
  }

  return (
    <div style={{
      background: 'linear-gradient(180deg, #f8f9fa 0%, #e9ecef 100%)', 
      minHeight:'100vh', 
      padding:'20px',
      fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
    }}>
      {/* Back Button - Medical style */}
      <button 
        onClick={() => navigate('/')} 
        style={{
          position: 'fixed',
          top: '20px',
          left: '20px',
          zIndex: 10000,
          background: '#ffffff',
          color: '#1a365d',
          border: '1px solid #cbd5e0',
          padding: '10px 20px',
          borderRadius: '6px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '14px',
          fontWeight: '600',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
        }}
      >
        ← Back to Home
      </button>

      {/* Professional Medical Header */}
      <header style={{
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        padding: '20px 28px',
        marginBottom: '20px',
        marginTop: '50px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
      }}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:'20px'}}>
          <div style={{display:'flex',alignItems:'center',gap:'16px'}}>
            {/* Medical ECG Icon */}
            <div style={{
              width: '48px',
              height: '48px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: '#fef2f2',
              borderRadius: '8px',
              border: '2px solid #fecaca'
            }}>
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <path d="M2 16 L8 16 L10 6 L14 26 L18 10 L22 22 L26 16 L30 16" 
                  stroke="#dc2626" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
              </svg>
            </div>
            <div>
              <h1 style={{margin:0,fontSize:'24px',fontWeight:700,color:'#1a202c',letterSpacing:'-0.5px'}}>
                NextECG <span style={{color:'#718096',fontWeight:400,fontSize:'16px'}}>|</span> <span style={{color:'#2d3748',fontWeight:500,fontSize:'18px'}}>6-Lead ECG Monitor</span>
              </h1>
              <p style={{margin:'4px 0 0 0',fontSize:'13px',color:'#718096'}}>Professional Cardiac Monitoring System • FDA Class II Device Compatible</p>
            </div>
          </div>
          
          {/* Real-time Vital Signs Display */}
          <div style={{display:'flex',gap:'24px',alignItems:'center'}}>
            {/* Heart Rate */}
            <div style={{
              background: heartRate > 0 ? '#fef2f2' : '#f7fafc',
              border: `2px solid ${heartRate > 0 ? '#fecaca' : '#e2e8f0'}`,
              borderRadius: '8px',
              padding: '12px 20px',
              textAlign: 'center',
              minWidth: '120px'
            }}>
              <div style={{fontSize:'11px',fontWeight:600,color:'#718096',textTransform:'uppercase',letterSpacing:'0.5px'}}>Heart Rate</div>
              <div style={{fontSize:'32px',fontWeight:700,color: heartRate > 100 ? '#dc2626' : heartRate > 0 ? '#16a34a' : '#a0aec0',lineHeight:1.1}}>
                {heartRate > 0 ? heartRate : '--'}
              </div>
              <div style={{fontSize:'12px',color:'#718096'}}>BPM</div>
              {heartRate > 0 && (
                <div style={{fontSize:'10px',color:'#a0aec0',marginTop:'2px'}}>
                  {hrvMetrics.minHR}-{hrvMetrics.maxHR} range
                </div>
              )}
            </div>
            
            {/* Comprehensive HRV Analysis Panel */}
            <div style={{
              background: 'linear-gradient(135deg, #f7fafc 0%, #edf2f7 100%)',
              border: `2px solid ${hrvStatus === 'low' ? '#fed7d7' : hrvStatus === 'athletic' ? '#c6f6d5' : hrvStatus === 'high' ? '#bee3f8' : '#e2e8f0'}`,
              borderRadius: '12px',
              padding: '16px',
              flex: 1,
              minWidth: '400px'
            }}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:'12px'}}>
                <div style={{fontSize:'12px',fontWeight:700,color:'#2d3748',textTransform:'uppercase',letterSpacing:'0.5px'}}>
                  6-Lead HRV Analysis
                </div>
                <div style={{
                  fontSize:'10px',
                  fontWeight:600,
                  padding:'3px 8px',
                  borderRadius:'10px',
                  background: hrvStatus === 'low' ? '#fed7d7' : hrvStatus === 'athletic' ? '#c6f6d5' : hrvStatus === 'high' ? '#bee3f8' : '#e2e8f0',
                  color: hrvStatus === 'low' ? '#c53030' : hrvStatus === 'athletic' ? '#276749' : hrvStatus === 'high' ? '#2b6cb0' : '#4a5568'
                }}>
                  {hrvStatus === 'low' ? '⚠ Low HRV' : hrvStatus === 'athletic' ? '💪 Athletic' : hrvStatus === 'high' ? '✓ Excellent' : '● Normal'}
                </div>
              </div>
              
              {/* Time Domain Metrics */}
              <div style={{marginBottom:'12px'}}>
                <div style={{fontSize:'10px',color:'#718096',fontWeight:600,marginBottom:'6px'}}>TIME DOMAIN</div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(4, 1fr)',gap:'8px'}}>
                  <div style={{textAlign:'center',background:'#fff',padding:'8px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                    <div style={{fontSize:'16px',fontWeight:700,color:'#2d3748'}}>{hrvMetrics.sdnn || '--'}</div>
                    <div style={{fontSize:'9px',color:'#718096'}}>SDNN (ms)</div>
                  </div>
                  <div style={{textAlign:'center',background:'#fff',padding:'8px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                    <div style={{fontSize:'16px',fontWeight:700,color:'#2d3748'}}>{hrvMetrics.rmssd || '--'}</div>
                    <div style={{fontSize:'9px',color:'#718096'}}>RMSSD (ms)</div>
                  </div>
                  <div style={{textAlign:'center',background:'#fff',padding:'8px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                    <div style={{fontSize:'16px',fontWeight:700,color:'#2d3748'}}>{hrvMetrics.pnn50 || '--'}</div>
                    <div style={{fontSize:'9px',color:'#718096'}}>pNN50 (%)</div>
                  </div>
                  <div style={{textAlign:'center',background:'#fff',padding:'8px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                    <div style={{fontSize:'16px',fontWeight:700,color:'#2d3748'}}>{hrvMetrics.meanRR || '--'}</div>
                    <div style={{fontSize:'9px',color:'#718096'}}>Mean RR</div>
                  </div>
                </div>
              </div>
              
              {/* Frequency Domain Metrics */}
              <div style={{marginBottom:'12px'}}>
                <div style={{fontSize:'10px',color:'#718096',fontWeight:600,marginBottom:'6px'}}>FREQUENCY DOMAIN</div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(4, 1fr)',gap:'8px'}}>
                  <div style={{textAlign:'center',background:'#fff',padding:'8px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                    <div style={{fontSize:'16px',fontWeight:700,color:'#e53e3e'}}>{hrvMetrics.lfPower || '--'}</div>
                    <div style={{fontSize:'9px',color:'#718096'}}>LF Power</div>
                  </div>
                  <div style={{textAlign:'center',background:'#fff',padding:'8px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                    <div style={{fontSize:'16px',fontWeight:700,color:'#3182ce'}}>{hrvMetrics.hfPower || '--'}</div>
                    <div style={{fontSize:'9px',color:'#718096'}}>HF Power</div>
                  </div>
                  <div style={{textAlign:'center',background:'#fff',padding:'8px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                    <div style={{fontSize:'16px',fontWeight:700,color:'#805ad5'}}>{hrvMetrics.lfHfRatio || '--'}</div>
                    <div style={{fontSize:'9px',color:'#718096'}}>LF/HF</div>
                  </div>
                  <div style={{textAlign:'center',background:'#fff',padding:'8px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                    <div style={{fontSize:'16px',fontWeight:700,color:'#2d3748'}}>{hrvMetrics.respiratoryRate || '--'}</div>
                    <div style={{fontSize:'9px',color:'#718096'}}>Resp/min</div>
                  </div>
                </div>
              </div>
              
              {/* Additional Metrics */}
              <div style={{display:'grid',gridTemplateColumns:'repeat(3, 1fr)',gap:'8px'}}>
                <div style={{textAlign:'center',background:'#fff',padding:'6px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                  <div style={{fontSize:'14px',fontWeight:700,color: hrvMetrics.stressIndex > 150 ? '#e53e3e' : hrvMetrics.stressIndex > 50 ? '#dd6b20' : '#38a169'}}>
                    {hrvMetrics.stressIndex || '--'}
                  </div>
                  <div style={{fontSize:'9px',color:'#718096'}}>Stress Index</div>
                </div>
                <div style={{textAlign:'center',background:'#fff',padding:'6px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                  <div style={{fontSize:'14px',fontWeight:700,color:'#2d3748'}}>{hrvMetrics.triangularIndex || '--'}</div>
                  <div style={{fontSize:'9px',color:'#718096'}}>HRV TI</div>
                </div>
                <div style={{textAlign:'center',background:'#fff',padding:'6px 4px',borderRadius:'6px',border:'1px solid #e2e8f0'}}>
                  <div style={{fontSize:'14px',fontWeight:700,color:'#2d3748'}}>{hrvMetrics.pnn20 || '--'}</div>
                  <div style={{fontSize:'9px',color:'#718096'}}>pNN20 (%)</div>
                </div>
              </div>
            </div>
            
            {/* Status Indicator */}
            <div style={{
              background: isCalibrating ? '#fffbeb' : isRecording ? '#fef2f2' : isWaiting ? '#f3e8ff' : (connected ? '#f0fdf4' : '#f9fafb'),
              border: `2px solid ${isCalibrating ? '#fde68a' : isRecording ? '#fecaca' : isWaiting ? '#e9d5ff' : (connected ? '#bbf7d0' : '#e5e7eb')}`,
              borderRadius: '8px',
              padding: '12px 16px',
              textAlign: 'center',
              minWidth: '140px'
            }}>
              <div style={{fontSize:'11px',fontWeight:600,color:'#718096',textTransform:'uppercase',letterSpacing:'0.5px'}}>System Status</div>
              <div style={{
                fontSize:'14px',
                fontWeight:700,
                color: isCalibrating ? '#d97706' : isRecording ? '#dc2626' : isWaiting ? '#7c3aed' : (connected ? '#16a34a' : '#6b7280'),
                marginTop:'4px'
              }}>
                {isCalibrating ? '⏳ Calibrating...' : 
                 isRecording ? `● REC ${recordingProgress.toFixed(1)}s` : 
                 isWaiting ? `Processing ${(WAIT_SECONDS - waitProgress).toFixed(1)}s` :
                 (connected ? '● Connected' : '○ Disconnected')}
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Final Report Modal */}
      {showReport && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.85)', zIndex: 9999,
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', padding: '20px', overflowY: 'auto'
        }}>
          <div style={{ maxWidth: '100%', textAlign: 'center', background: '#fff', padding: '24px', borderRadius: '12px', maxHeight: '95vh', overflowY: 'auto' }}>
            <h2 style={{ color: '#1a202c', marginBottom: '20px', fontSize: '20px', fontWeight: '600' }}>
              📋 ECG Report — 6-Lead Analysis
            </h2>
            <canvas ref={reportCanvasRef} style={{
              maxWidth: '100%', height: 'auto',
              border: '1px solid #e2e8f0', borderRadius: '4px',
              boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
            }} />
            
            {/* Action Buttons Row 1 */}
            <div style={{ marginTop: '20px', display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button onClick={downloadReport} style={{
                background: '#dc2626', color: '#ffffff', fontWeight: '600', padding: '12px 24px',
                border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px',
                display: 'flex', alignItems: 'center', gap: '8px'
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                </svg>
                Download Report
              </button>
              <button onClick={()=>{ setShowReport(false); if(connected && !isCalibrating) { setRecordedData(null); startRecording() } }} style={{ 
                background: '#16a34a', color: '#fff', fontWeight: '600', padding: '12px 24px',
                border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px',
                display: 'flex', alignItems: 'center', gap: '8px'
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 4v6h6M23 20v-6h-6"/>
                  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
                </svg>
                New Recording
              </button>
              <button onClick={()=>setShowReport(false)} style={{ 
                background: '#f3f4f6', color: '#374151', padding: '12px 24px',
                border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '14px'
              }}>
                Close
              </button>
            </div>

            {/* WhatsApp Share Section */}
            <div style={{ 
              marginTop: '20px', 
              padding: '16px', 
              background: '#f0fdf4', 
              borderRadius: '8px',
              border: '1px solid #86efac'
            }}>
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                justifyContent: 'center',
                gap: '8px',
                marginBottom: '12px',
                color: '#166534',
                fontWeight: '600',
                fontSize: '15px'
              }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="#25D366">
                  <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                </svg>
                Share via WhatsApp
              </div>
              
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
                {/* Quick Share Button */}
                <button onClick={shareToWhatsApp} style={{
                  background: '#25D366', color: '#fff', fontWeight: '600', padding: '12px 20px',
                  border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px',
                  display: 'flex', alignItems: 'center', gap: '8px',
                  boxShadow: '0 2px 4px rgba(37,211,102,0.3)'
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/>
                  </svg>
                  Quick Share
                </button>

                {/* Toggle for sending to specific number */}
                <button onClick={() => setShowWhatsAppInput(!showWhatsAppInput)} style={{
                  background: showWhatsAppInput ? '#166534' : '#fff', 
                  color: showWhatsAppInput ? '#fff' : '#166534', 
                  fontWeight: '600', padding: '12px 20px',
                  border: '2px solid #25D366', borderRadius: '6px', cursor: 'pointer', fontSize: '14px',
                  display: 'flex', alignItems: 'center', gap: '8px'
                }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                  </svg>
                  Send to Number
                </button>
              </div>

              {/* Phone Number Input */}
              {showWhatsAppInput && (
                <div style={{ marginTop: '12px', display: 'flex', gap: '8px', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input 
                    type="tel"
                    value={whatsappNumber}
                    onChange={(e) => setWhatsappNumber(e.target.value)}
                    placeholder="+1 234 567 8900"
                    style={{
                      padding: '10px 14px',
                      border: '2px solid #25D366',
                      borderRadius: '6px',
                      fontSize: '14px',
                      width: '180px',
                      outline: 'none'
                    }}
                  />
                  <button 
                    onClick={() => {
                      if (whatsappNumber.trim()) {
                        shareToWhatsAppNumber(whatsappNumber)
                      } else {
                        alert('Please enter a phone number')
                      }
                    }}
                    style={{
                      background: '#25D366', color: '#fff', fontWeight: '600', padding: '10px 20px',
                      border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px'
                    }}
                  >
                    Send
                  </button>
                </div>
              )}

              <p style={{ 
                marginTop: '10px', 
                fontSize: '12px', 
                color: '#6b7280',
                marginBottom: 0
              }}>
                📎 The report image will be downloaded. Attach it to your WhatsApp message.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Bluetooth Device Selection Modal */}
      {showDeviceList && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            background: '#fff', borderRadius: '12px', padding: '24px', maxWidth: '400px', width: '90%',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)'
          }}>
            <h3 style={{ margin: '0 0 16px 0', color: '#1a365d' }}>
              📱 Select Bluetooth Device
            </h3>
            <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '16px' }}>
              Select your paired HC-05 module to connect:
            </p>
            {pairedDevices.length === 0 ? (
              <p style={{ color: '#dc2626', fontSize: '14px' }}>
                No paired devices found. Please pair your HC-05 in Android Bluetooth settings first (PIN: 1234).
              </p>
            ) : (
              <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                {pairedDevices.map((device, idx) => (
                  <button
                    key={device.address || device.id || idx}
                    onClick={() => connectBluetooth(device.address || device.id)}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '12px 16px', marginBottom: '8px',
                      background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px',
                      cursor: 'pointer', fontSize: '14px'
                    }}
                  >
                    <strong style={{ color: '#1a365d' }}>{device.name || 'Unknown Device'}</strong>
                    <br />
                    <span style={{ color: '#6b7280', fontSize: '12px' }}>{device.address || device.id}</span>
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
              <button
                onClick={() => setShowDeviceList(false)}
                style={{
                  flex: 1, padding: '10px', background: '#f1f5f9', border: 'none',
                  borderRadius: '6px', cursor: 'pointer', fontWeight: '500'
                }}
              >
                Cancel
              </button>
              <button
                onClick={loadPairedDevices}
                style={{
                  flex: 1, padding: '10px', background: '#3b82f6', color: '#fff', border: 'none',
                  borderRadius: '6px', cursor: 'pointer', fontWeight: '500'
                }}
              >
                Refresh
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Control Panel - Medical Grade */}
      <div style={{
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        padding: '16px 20px',
        marginBottom: '16px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
      }}>
        <div style={{display:'flex',gap:'12px',alignItems:'center',flexWrap:'wrap'}}>
          {/* Connection Mode Toggle (only show if not in Capacitor auto-mode) */}
          {!isCapacitor && (
            <div style={{display:'flex',gap:'4px',alignItems:'center',paddingRight:'12px',borderRight:'1px solid #e2e8f0'}}>
              <button
                onClick={() => setConnectionMode('serial')}
                style={{
                  padding: '6px 12px', fontSize: '12px', fontWeight: '500',
                  background: connectionMode === 'serial' ? '#1a365d' : '#f1f5f9',
                  color: connectionMode === 'serial' ? '#fff' : '#4a5568',
                  border: 'none', borderRadius: '4px 0 0 4px', cursor: 'pointer'
                }}
              >
                USB
              </button>
              <button
                onClick={() => setConnectionMode('bluetooth')}
                style={{
                  padding: '6px 12px', fontSize: '12px', fontWeight: '500',
                  background: connectionMode === 'bluetooth' ? '#1a365d' : '#f1f5f9',
                  color: connectionMode === 'bluetooth' ? '#fff' : '#4a5568',
                  border: 'none', borderRadius: '0 4px 4px 0', cursor: 'pointer'
                }}
              >
                Bluetooth
              </button>
            </div>
          )}
          
          {/* Connection Controls */}
          <div style={{display:'flex',gap:'8px',alignItems:'center',paddingRight:'16px',borderRight:'1px solid #e2e8f0'}}>
            {!connected ? (
              <button onClick={handleConnect} style={{
                background: '#1a365d', color: '#fff', border: 'none', padding: '10px 20px',
                borderRadius: '6px', cursor: 'pointer', fontWeight: '600', fontSize: '14px',
                display: 'flex', alignItems: 'center', gap: '6px'
              }}>
                <span>●</span> {connectionMode === 'bluetooth' || isCapacitor ? 'Connect Bluetooth' : 'Connect Device'}
              </button>
            ) : (
              <>
                <button onClick={disconnect} style={{
                  background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca', padding: '10px 16px',
                  borderRadius: '6px', cursor: 'pointer', fontWeight: '600', fontSize: '13px'
                }}>
                  Disconnect
                </button>
                {!isRecording && !isCalibrating && (
                  <button onClick={startRecording} style={{
                    background: '#16a34a', color: '#fff', border: 'none', padding: '10px 20px',
                    borderRadius: '6px', cursor: 'pointer', fontWeight: '600', fontSize: '14px'
                  }}>
                    ▶ Start Recording
                  </button>
                )}
              </>
            )}
            {isRecording && (
              <button onClick={()=>stopRecording()} style={{
                background: '#dc2626', color: '#fff', border: 'none', padding: '10px 20px',
                borderRadius: '6px', cursor: 'pointer', fontWeight: '600', fontSize: '14px',
                animation: 'pulse 1.5s infinite'
              }}>
                ■ Stop Recording
              </button>
            )}
          </div>

          {connectError && (
            <div style={{color:'#dc2626',background:'#fef2f2',padding:'8px 12px',borderRadius:'6px',fontSize:'13px',border:'1px solid #fecaca'}}>
              <strong>Connection Error:</strong> {connectError}
            </div>
          )}
          
          {/* Settings Controls */}
          <div style={{display:'flex',gap:'12px',alignItems:'center',flexWrap:'wrap',flex:1}}>
            <label style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'13px',color:'#4a5568'}}>
              <span style={{fontWeight:500}}>Gain:</span>
              <input type="range" min="0.2" max="6" step="0.1" value={gain} onChange={e=>setGain(parseFloat(e.target.value))} 
                style={{width:'80px'}} />
              <span style={{minWidth:'32px',color:'#718096'}}>{gain.toFixed(1)}x</span>
            </label>
            
            <label style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'13px',color:'#4a5568'}}>
              <span style={{fontWeight:500}}>Resolution:</span>
              <input type="range" min="1" max="6" step="0.5" value={pixelsPerMm} onChange={e=>setPixelsPerMm(parseFloat(e.target.value))} 
                style={{width:'60px'}} />
            </label>
            
            <label style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'13px',color:'#4a5568'}}>
              <span style={{fontWeight:500}}>Window:</span>
              <input type="number" min="1" max="10" value={secondsWindow} onChange={e=>setSecondsWindow(parseInt(e.target.value)||1)} 
                style={{width:'50px',padding:'4px 8px',border:'1px solid #d1d5db',borderRadius:'4px'}} />
              <span style={{color:'#718096'}}>s</span>
            </label>
            
            <label style={{display:'flex',alignItems:'center',gap:'8px',fontSize:'13px',color:'#4a5568'}}>
              <span style={{fontWeight:500}}>Sample Rate:</span>
              <input type="number" min="20" max="1000" step="1" value={sampleRate} onChange={e=>setSampleRate(Math.max(1, parseInt(e.target.value)||DEFAULT_SAMPLE_RATE))} 
                style={{width:'60px',padding:'4px 8px',border:'1px solid #d1d5db',borderRadius:'4px'}} />
              <span style={{color:'#718096'}}>Hz</span>
            </label>
            
            <label style={{display:'flex',alignItems:'center',gap:'6px',fontSize:'13px',color:'#4a5568',cursor:'pointer'}}>
              <input type="checkbox" checked={filterOn} onChange={e=>setFilterOn(e.target.checked)} 
                style={{width:'16px',height:'16px',accentColor:'#16a34a'}} />
              <span>Bandpass Filter (0.5–40 Hz)</span>
            </label>
          </div>

          {/* Export Actions */}
          <div style={{display:'flex',gap:'8px',alignItems:'center',paddingLeft:'16px',borderLeft:'1px solid #e2e8f0'}}>
            <button onClick={exportPNG} style={{
              background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', padding: '8px 14px',
              borderRadius: '6px', cursor: 'pointer', fontWeight: '500', fontSize: '13px'
            }}>
              Export PNG
            </button>
            {recordedData && !isWaiting && (
              <button onClick={() => setShowReport(true)} style={{
                background: '#dc2626', color: '#fff', border: 'none', padding: '8px 14px',
                borderRadius: '6px', cursor: 'pointer', fontWeight: '600', fontSize: '13px'
              }}>
                View Report
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ECG Lead Strips - Medical Paper Style */}
      <div style={{
        background: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: '8px',
        padding: '16px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
      }}>
        <div style={{
          display:'flex',
          justifyContent:'space-between',
          alignItems:'center',
          marginBottom:'12px',
          paddingBottom:'12px',
          borderBottom:'1px solid #e2e8f0'
        }}>
          <div style={{fontSize:'14px',fontWeight:600,color:'#1a202c'}}>
            Real-Time 6-Lead ECG
          </div>
          <div style={{display:'flex',gap:'16px',fontSize:'12px',color:'#718096'}}>
            <span>Paper Speed: <strong style={{color:'#2d3748'}}>25 mm/s</strong></span>
            <span>Sensitivity: <strong style={{color:'#2d3748'}}>10 mm/mV</strong></span>
            <span>Sample Rate: <strong style={{color:'#2d3748'}}>{sampleRate} Hz</strong></span>
          </div>
        </div>
        
        {leadPairs.map((pair, rowIdx)=> {
          const [leftIdx, rightIdx] = pair
          return (
            <div key={rowIdx} style={{
              background: '#fefdfb',
              border: '1px solid #e5e0d8',
              borderRadius: '4px',
              padding: '8px',
              marginBottom: rowIdx < leadPairs.length - 1 ? '8px' : 0
            }}>
              <div style={{
                display:'flex',
                justifyContent:'space-between',
                alignItems:'center',
                marginBottom:'4px'
              }}>
                <div style={{fontSize:'13px',fontWeight:600,color:'#1a202c'}}>
                  {leads[leftIdx]} <span style={{color:'#a0aec0',margin:'0 8px'}}>|</span> {leads[rightIdx]}
                </div>
                <div style={{fontSize:'11px',color:'#a0aec0'}}>
                  1 mV = 10 mm
                </div>
              </div>
              <canvas
                ref={el=>{ pairCanvasRefs.current[rowIdx]=el; if(el) sizeAllCanvases() }}
                style={{width:'100%',height:100,borderRadius:'2px'}}
              />
            </div>
          )
        })}
      </div>

      {/* Professional Footer */}
      <div style={{
        marginTop:'16px',
        padding:'12px 16px',
        background:'#f7fafc',
        border:'1px solid #e2e8f0',
        borderRadius:'6px',
        fontSize:'12px',
        color:'#718096',
        textAlign:'center'
      }}>
        <strong style={{color:'#4a5568'}}>Clinical Note:</strong> This device is intended for research and educational purposes. 
        Recording automatically starts after device calibration. For diagnostic use, ensure proper electrode placement and patient preparation.
      </div>

      {/* Add pulse animation for recording button */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </div>
  )
}
