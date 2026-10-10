import { useEffect, useRef } from 'react'

const INTRO_MS = 2_400
export const STARTUP_ANIMATION_MS = INTRO_MS + 100
const TAU = Math.PI * 2

function smooth(value: number) {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

/** A bounded, local particle field. Frames never update React state. */
function ParticleField({ waiting }: { waiting: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const stage = canvas.parentElement!
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const colors = getComputedStyle(stage)
    const palette = [colors.getPropertyValue('--startup-particle-primary').trim(), colors.getPropertyValue('--startup-particle-secondary').trim(), colors.getPropertyValue('--startup-particle-highlight').trim()]
    let seed = 7321
    const random = () => {
      seed = (seed * 16807) % 2147483647
      return (seed - 1) / 2147483646
    }
    const particles = Array.from({ length: 390 }, (_, index) => ({
      angle: Math.floor(index / 3) / 130 * TAU,
      strand: index % 3,
      offset: (random() - .5) * 11,
      startX: (random() - .5) * 570,
      startY: (random() - .5) * 320,
      radius: .8 + random() * .85,
      sparkle: random(),
    }))
    const dust = Array.from({ length: 42 }, () => ({ x: random(), y: random(), radius: .5 + random() * .7, phase: random() * TAU }))
    // Reuse position buffers rather than allocating objects on every frame.
    const positions = new Float32Array(particles.length * 3)
    let width = 0
    let height = 0
    let frame = 0
    let elapsed = waiting || motion.matches ? INTRO_MS : 0
    const startedAt = performance.now()

    const draw = (time: number) => {
      if (!width || !height) return
      context.clearRect(0, 0, width, height)
      const scale = Math.min(width / 570, height / 330)
      const centerX = width / 2
      const centerY = height * .5
      const gather = smooth((time - 70) / 1_650)
      const emerge = .2 + .8 * smooth(time / 650)
      const seconds = time / 1_000
      const turn = -.32 + seconds * .13
      const cos = Math.cos(turn)
      const sin = Math.sin(turn)
      const glow = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, 150 * scale)
      glow.addColorStop(0, palette[1])
      glow.addColorStop(1, 'transparent')
      context.globalAlpha = .055 * emerge
      context.fillStyle = glow
      context.fillRect(0, 0, width, height)

      for (const point of dust) {
        context.globalAlpha = (.12 + .12 * Math.sin(seconds * .6 + point.phase)) * emerge
        context.fillStyle = palette[0]
        context.beginPath()
        context.arc(point.x * width, point.y * height, point.radius * scale, 0, TAU)
        context.fill()
      }

      for (let index = 0; index < particles.length; index += 1) {
        const point = particles[index]
        const angle = point.angle + seconds * .18
        const phase = point.strand * TAU / 3
        // Three interwoven ribbons form an asymmetric, open luminous knot.
        const fold = Math.cos(angle * 3 + phase)
        const x = Math.cos(angle) * (125 + 22 * fold + point.offset)
        const y = Math.sin(angle * 2 + phase * .18) * (58 + 18 * fold + point.offset)
        const z = Math.sin(angle * 3 + phase) * 39
        const perspective = 330 / (330 + z)
        const targetX = (x * cos - y * sin) * perspective
        const targetY = (x * sin + y * cos) * perspective
        const swirl = (1 - gather) * Math.sin(seconds * 1.6 + point.angle) * 26
        const slot = index * 3
        positions[slot] = centerX + ((point.startX + swirl) * (1 - gather) + targetX * gather) * scale
        positions[slot + 1] = centerY + (point.startY * (1 - gather) + targetY * gather) * scale
        positions[slot + 2] = (z + 39) / 78
      }

      // Fine broken filaments connect only neighbours in the same ribbon.
      context.lineWidth = .55 * scale
      for (let index = 0; index < particles.length - 3; index += 1) {
        const slot = index * 3
        const next = slot + 9
        if (Math.hypot(positions[slot] - positions[next], positions[slot + 1] - positions[next + 1]) > 22 * scale) continue
        context.globalAlpha = (.1 + positions[slot + 2] * .16) * gather * emerge
        context.strokeStyle = palette[particles[index].strand === 1 ? 1 : 0]
        context.beginPath()
        context.moveTo(positions[slot], positions[slot + 1])
        context.lineTo(positions[next], positions[next + 1])
        context.stroke()
      }
      for (let index = 0; index < particles.length; index += 1) {
        const point = particles[index]
        const slot = index * 3
        const depth = positions[slot + 2]
        const radius = point.radius * (.75 + depth * .5) * scale
        context.fillStyle = palette[point.strand === 1 ? 1 : 0]
        context.globalAlpha = (.38 + depth * .55) * emerge
        context.beginPath()
        context.arc(positions[slot], positions[slot + 1], radius, 0, TAU)
        context.fill()
        if (point.sparkle > .93) {
          context.globalAlpha = .07 * emerge
          context.beginPath()
          context.arc(positions[slot], positions[slot + 1], radius * 4, 0, TAU)
          context.fill()
          context.fillStyle = palette[2]
          context.globalAlpha = .9 * emerge
          context.beginPath()
          context.arc(positions[slot], positions[slot + 1], radius * .45, 0, TAU)
          context.fill()
        }
      }
      context.globalAlpha = 1
      canvas.dataset.ready = 'true'
    }

    const resize = () => {
      width = stage.clientWidth
      height = stage.clientHeight
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      draw(elapsed)
    }
    const tick = (now: number) => {
      frame = 0
      elapsed = Math.min(INTRO_MS, now - startedAt)
      draw(elapsed)
      if (elapsed < INTRO_MS && !document.hidden && !motion.matches) frame = requestAnimationFrame(tick)
    }
    const resume = () => {
      cancelAnimationFrame(frame)
      frame = 0
      if (motion.matches || waiting) {
        elapsed = INTRO_MS
        draw(elapsed)
      } else if (!document.hidden && elapsed < INTRO_MS) frame = requestAnimationFrame(tick)
    }
    const observer = new ResizeObserver(resize)
    resize()
    observer.observe(stage)
    resume()
    document.addEventListener('visibilitychange', resume)
    motion.addEventListener('change', resume)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', resume)
      motion.removeEventListener('change', resume)
    }
  }, [waiting])

  return <canvas ref={canvasRef} className="zsense-startup-particles" aria-hidden="true" />
}

export function StartupScreen({ stage, waiting }: { stage: string; waiting: boolean }) {
  return <div className={`zsense-startup${waiting ? ' zsense-startup--waiting' : ''}`} role="status" aria-live="polite" aria-busy="true">
    <div className="zsense-startup-inner">
      <div className="zsense-startup-art" aria-hidden="true">
        <ParticleField waiting={waiting} />
        <span className="zsense-startup-seed" />
      </div>
      <div className="zsense-startup-copy">
        <strong className="zsense-startup-name">ZSense</strong>
        <span className="zsense-startup-tagline">你的智能工作空间</span>
        <div className="zsense-startup-progress" aria-hidden="true" />
        <span className="zsense-startup-stage">{stage}</span>
      </div>
    </div>
  </div>
}
