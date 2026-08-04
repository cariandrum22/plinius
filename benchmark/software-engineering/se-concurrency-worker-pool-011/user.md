## Context

You are reviewing a Rust worker pool used inside a media-processing service. Incoming jobs (e.g., thumbnail generation requests) are submitted from an HTTP handler thread and processed by a fixed number of worker threads that run a caller-supplied processing closure. The pool has been running in production for a few months. Two separate problems have surfaced:

1. During traffic spikes (e.g., a bulk re-processing kicked off by a batch job), memory usage on the service grows without bound until the process is OOM-killed by the orchestrator, even though CPU usage on the worker threads stays saturated but stable. The service recovers fine after restart, but the same pattern repeats on the next spike.
2. During deploys, the service calls `shutdown()` as part of its graceful-termination hook before the process exits. Log analysis after several deploys shows that jobs submitted shortly before a deploy are sometimes never processed at all — no error, no log line, nothing — and there have also been isolated reports (harder to reproduce) of a deploy hanging past its termination grace period, forcing a hard kill.

Here is the current implementation:

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub struct Job {
    pub id: u64,
    pub payload: Vec<u8>,
}

pub struct WorkerPool {
    sender: Sender<Job>,
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<()>>,
}

impl WorkerPool {
    pub fn new(num_workers: usize, process: Arc<dyn Fn(Job) + Send + Sync>) -> Self {
        let (sender, receiver) = mpsc::channel::<Job>();
        let receiver = Arc::new(Mutex::new(receiver));
        let stop = Arc::new(AtomicBool::new(false));

        let mut workers = Vec::with_capacity(num_workers);
        for _ in 0..num_workers {
            let receiver = Arc::clone(&receiver);
            let stop = Arc::clone(&stop);
            let process = Arc::clone(&process);
            let handle = thread::spawn(move || loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let job = receiver.lock().unwrap().try_recv();
                match job {
                    Ok(job) => process(job),
                    Err(_) => thread::sleep(Duration::from_millis(10)),
                }
            });
            workers.push(handle);
        }

        WorkerPool { sender, stop, workers }
    }

    /// Enqueue a job for processing. Callers never block on submission,
    /// regardless of how deep the backlog is.
    pub fn submit(&self, job: Job) {
        self.sender.send(job).expect("worker pool channel closed");
    }

    /// Signal all workers to stop and wait for their threads to exit.
    pub fn shutdown(self) {
        self.stop.store(true, Ordering::Relaxed);
        for handle in self.workers {
            handle.join().unwrap();
        }
    }
}
```

`process` performs blocking I/O (writing generated thumbnails to object storage) and can take anywhere from a few milliseconds to a couple of seconds per job depending on backend load. `submit` is called from many HTTP handler threads concurrently. `num_workers` is fixed at pool creation and is small relative to peak submission rate.

## Deliverable

Provide:

1. A precise explanation of why memory grows without bound during traffic spikes, tied to the specific data structure and API used for job submission.
2. A precise explanation of the shutdown defects: why jobs submitted shortly before `shutdown()` can be silently lost, and a plausible mechanism by which a deploy could instead hang past its grace period.
3. A redesigned pool that provides correct backpressure (bounding memory/queue growth under sustained overload) and a graceful shutdown with well-defined draining semantics (a clear answer to: what happens to jobs already queued when shutdown begins, and to jobs submitted during or after shutdown). Discuss the trade-offs of your design choices — how you size the bound and what you do when it is reached (block the submitter, reject/fail fast, or drop with a signal to the caller), and how you decide what "graceful" means for in-flight versus merely-queued work, including any limits on how long shutdown is allowed to wait.
