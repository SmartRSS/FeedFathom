---------------------------- MODULE SourceEnqueue ----------------------------
EXTENDS TLC

CONSTANTS Requests, Reverted

RevertibleFixes ==
  {"addWithoutLooking", "followUpThroughEnqueue", "mergeInSteps",
   "deferralDropsFollowUp"}

ASSUME Reverted \subseteq RevertibleFixes

VARIABLES
  job, jobSkipCache, marker,
  worker, request, followUp, checking, adding,
  caller, asked, taken,
  owed, fetchedSince, markedLate, addLost

vars ==
  <<job, jobSkipCache, marker, worker, request, followUp, checking, adding,
    caller, asked, taken, owed, fetchedSince, markedLate, addLost>>

JobStates == {"none", "waiting", "active", "delayed"}
MarkerValues == {"none", "0", "1"}
WorkerSteps ==
  {"idle", "take", "parse", "takeForReenqueue", "reenqueue", "updateData",
   "moveToDelayed", "finish"}
CallerSteps ==
  {"idle", "getState", "merge", "takeForMerge", "updateQueued",
   "mark", "add", "acked", "failed"}

TypeOK ==
  /\ job \in JobStates
  /\ jobSkipCache \in BOOLEAN
  /\ marker \in MarkerValues
  /\ worker \in WorkerSteps
  /\ request \in BOOLEAN
  /\ followUp \in BOOLEAN
  /\ checking \in BOOLEAN
  /\ adding \in BOOLEAN
  /\ caller \in [Requests -> CallerSteps]
  /\ asked \in [Requests -> BOOLEAN]
  /\ taken \in [Requests -> MarkerValues]
  /\ owed \in [Requests -> BOOLEAN]
  /\ fetchedSince \in [Requests -> BOOLEAN]
  /\ markedLate \in [Requests -> BOOLEAN]
  /\ addLost \in [Requests -> BOOLEAN]

Init ==
  /\ job = "none"
  /\ jobSkipCache = FALSE
  /\ marker = "none"
  /\ worker = "idle"
  /\ request = FALSE
  /\ followUp = FALSE
  /\ checking = FALSE
  /\ adding = FALSE
  /\ caller = [r \in Requests |-> "idle"]
  /\ asked = [r \in Requests |-> FALSE]
  /\ taken = [r \in Requests |-> "none"]
  /\ owed = [r \in Requests |-> FALSE]
  /\ fetchedSince = [r \in Requests |-> FALSE]
  /\ markedLate = [r \in Requests |-> FALSE]
  /\ addLost = [r \in Requests |-> FALSE]

Reverts(fix) == fix \in Reverted

MergedMarker(skipCache) ==
  IF skipCache THEN "1" ELSE IF marker = "none" THEN "0" ELSE marker

Covers(value, skipCache) == value = "1" \/ (value = "0" /\ ~skipCache)

NoRunWillTakeMarker ==
  \/ job = "none"
  \/ job = "active" /\ worker \in {"takeForReenqueue", "reenqueue", "finish"}

Fetch(skipCache) ==
  /\ owed' = [r \in Requests |->
                IF caller[r] # "idle" /\ (skipCache \/ ~asked[r])
                THEN FALSE ELSE owed[r]]
  /\ fetchedSince' = [r \in Requests |-> caller[r] # "idle" \/ fetchedSince[r]]

NoFetch == UNCHANGED <<owed, fetchedSince>>

Ack(r) == caller' = [caller EXCEPT ![r] = "acked"]

GoTo(r, step) == caller' = [caller EXCEPT ![r] = step]

EnqueueSource(r) ==
  /\ caller[r] = "idle"
  /\ \E skipCache \in BOOLEAN : asked' = [asked EXCEPT ![r] = skipCache]
  /\ owed' = [owed EXCEPT ![r] = TRUE]
  /\ GoTo(r, CASE Reverts("addWithoutLooking") -> "add"
               [] job = "none" -> "mark"
               [] OTHER -> "getState")
  /\ UNCHANGED <<job, jobSkipCache, marker, worker, request, followUp,
                 checking, adding, taken, fetchedSince, markedLate, addLost>>

GetState(r) ==
  /\ caller[r] = "getState"
  /\ GoTo(r, IF job \in {"waiting", "delayed"}
             THEN IF Reverts("mergeInSteps") THEN "takeForMerge" ELSE "merge"
             ELSE "mark")
  /\ UNCHANGED <<job, jobSkipCache, marker, worker, request, followUp,
                 checking, adding, asked, taken, owed, fetchedSince,
                 markedLate, addLost>>

MergeQueuedRefresh(r) ==
  /\ caller[r] = "merge"
  /\ CASE job = "none" ->
            /\ GoTo(r, "mark")
            /\ UNCHANGED <<jobSkipCache, marker, markedLate>>
       [] job \in {"waiting", "delayed"} ->
            /\ jobSkipCache' = (asked[r] \/ jobSkipCache \/ marker = "1")
            /\ marker' = "none"
            /\ Ack(r)
            /\ UNCHANGED markedLate
       [] job = "active" ->
            /\ marker' = MergedMarker(asked[r])
            /\ markedLate' = [markedLate EXCEPT ![r] = NoRunWillTakeMarker]
            /\ Ack(r)
            /\ UNCHANGED jobSkipCache
  /\ UNCHANGED <<job, worker, request, followUp, checking, adding, asked,
                 taken, owed, fetchedSince, addLost>>

MergePendingRefresh(r) ==
  /\ caller[r] = "mark"
  /\ marker' = MergedMarker(asked[r])
  /\ GoTo(r, "add")
  /\ UNCHANGED <<job, jobSkipCache, worker, request, followUp, checking,
                 adding, asked, taken, owed, fetchedSince, markedLate,
                 addLost>>

TakeBeforeUpdateData(r) ==
  /\ caller[r] = "takeForMerge"
  /\ taken' = [taken EXCEPT ![r] = marker]
  /\ marker' = "none"
  /\ GoTo(r, "updateQueued")
  /\ UNCHANGED <<job, jobSkipCache, worker, request, followUp, checking,
                 adding, asked, owed, fetchedSince, markedLate, addLost>>

UpdateQueuedData(r) ==
  /\ caller[r] = "updateQueued"
  /\ IF job = "none"
     THEN /\ GoTo(r, "failed")
          /\ UNCHANGED jobSkipCache
     ELSE /\ jobSkipCache' = (asked[r] \/ taken[r] = "1")
          /\ Ack(r)
  /\ taken' = [taken EXCEPT ![r] = "none"]
  /\ UNCHANGED <<job, marker, worker, request, followUp, checking, adding,
                 asked, owed, fetchedSince, markedLate, addLost>>

Add(r) ==
  /\ caller[r] = "add"
  /\ IF job = "none"
     THEN /\ job' = "waiting"
          /\ jobSkipCache' = asked[r]
          /\ UNCHANGED addLost
     ELSE /\ addLost' = [addLost EXCEPT ![r] = ~Reverts("addWithoutLooking")]
          /\ UNCHANGED <<job, jobSkipCache>>
  /\ Ack(r)
  /\ UNCHANGED <<marker, worker, request, followUp, checking, adding, asked,
                 taken, owed, fetchedSince, markedLate>>

EnqueueDueSources ==
  /\ job = "none"
  /\ job' = "waiting"
  /\ jobSkipCache' = FALSE
  /\ UNCHANGED <<marker, worker, request, followUp, checking, adding, caller,
                 asked, taken, owed, fetchedSince, markedLate, addLost>>

PromoteDelayed ==
  /\ job = "delayed"
  /\ job' = "waiting"
  /\ UNCHANGED <<jobSkipCache, marker, worker, request, followUp, checking,
                 adding, caller, asked, taken, owed, fetchedSince,
                 markedLate, addLost>>

MoveToActive ==
  /\ job = "waiting"
  /\ worker = "idle"
  /\ job' = "active"
  /\ request' = jobSkipCache
  /\ worker' = "take"
  /\ UNCHANGED <<jobSkipCache, marker, followUp, checking, adding, caller,
                 asked, taken, owed, fetchedSince, markedLate, addLost>>

TakePendingRefresh ==
  /\ worker = "take"
  /\ request' = (request \/ marker = "1")
  /\ marker' = "none"
  /\ worker' = "parse"
  /\ UNCHANGED <<job, jobSkipCache, followUp, checking, adding, caller,
                 asked, taken, owed, fetchedSince, markedLate, addLost>>

ParseRequest ==
  /\ worker = "parse"
  /\ \/ /\ Fetch(request)
        /\ worker' = IF Reverts("followUpThroughEnqueue")
                     THEN "takeForReenqueue" ELSE "finish"
     \/ /\ NoFetch
        /\ worker' = IF Reverts("deferralDropsFollowUp")
                     THEN "moveToDelayed" ELSE "updateData"
  /\ UNCHANGED <<job, jobSkipCache, marker, request, followUp, checking,
                 adding, caller, asked, taken, markedLate, addLost>>

TakeForReenqueue ==
  /\ worker = "takeForReenqueue"
  /\ marker' = "none"
  /\ followUp' = (marker = "1")
  /\ worker' = IF marker = "none" THEN "finish" ELSE "reenqueue"
  /\ UNCHANGED <<job, jobSkipCache, request, checking, adding, caller, asked,
                 taken, owed, fetchedSince, markedLate, addLost>>

ReenqueueFollowUp ==
  /\ worker = "reenqueue"
  /\ marker' = MergedMarker(followUp)
  /\ worker' = "finish"
  /\ UNCHANGED <<job, jobSkipCache, request, followUp, checking, adding,
                 caller, asked, taken, owed, fetchedSince, markedLate,
                 addLost>>

UpdateDeferredData ==
  /\ worker = "updateData"
  /\ jobSkipCache' = request
  /\ worker' = "moveToDelayed"
  /\ UNCHANGED <<job, marker, request, followUp, checking, adding, caller,
                 asked, taken, owed, fetchedSince, markedLate, addLost>>

MoveToDelayed ==
  /\ worker = "moveToDelayed"
  /\ job' = "delayed"
  /\ worker' = "idle"
  /\ request' = FALSE
  /\ followUp' = FALSE
  /\ UNCHANGED <<jobSkipCache, marker, checking, adding, caller, asked, taken,
                 owed, fetchedSince, markedLate, addLost>>

MoveToFinished ==
  /\ worker = "finish"
  /\ job' = "none"
  /\ jobSkipCache' = FALSE
  /\ worker' = "idle"
  /\ request' = FALSE
  /\ followUp' = FALSE
  /\ checking' = (checking \/ ~Reverts("followUpThroughEnqueue"))
  /\ UNCHANGED <<marker, adding, caller, asked, taken, owed, fetchedSince,
                 markedLate, addLost>>

CheckPendingRefresh ==
  /\ checking
  /\ \E more \in BOOLEAN : checking' = more
  /\ adding' = (adding \/ marker # "none")
  /\ UNCHANGED <<job, jobSkipCache, marker, worker, request, followUp, caller,
                 asked, taken, owed, fetchedSince, markedLate, addLost>>

RequeuePendingRefresh ==
  /\ adding
  /\ \E more \in BOOLEAN : adding' = more
  /\ IF job = "none"
     THEN /\ job' = "waiting"
          /\ jobSkipCache' = FALSE
     ELSE UNCHANGED <<job, jobSkipCache>>
  /\ UNCHANGED <<marker, worker, request, followUp, checking, caller, asked,
                 taken, owed, fetchedSince, markedLate, addLost>>

Next ==
  \/ \E r \in Requests :
       \/ EnqueueSource(r)
       \/ GetState(r)
       \/ MergeQueuedRefresh(r)
       \/ MergePendingRefresh(r)
       \/ TakeBeforeUpdateData(r)
       \/ UpdateQueuedData(r)
       \/ Add(r)
  \/ EnqueueDueSources
  \/ PromoteDelayed
  \/ MoveToActive
  \/ TakePendingRefresh
  \/ ParseRequest
  \/ TakeForReenqueue
  \/ ReenqueueFollowUp
  \/ UpdateDeferredData
  \/ MoveToDelayed
  \/ MoveToFinished
  \/ CheckPendingRefresh
  \/ RequeuePendingRefresh

Spec == Init /\ [][Next]_vars

Idle == job = "none" /\ ~checking /\ ~adding

Acked(r) == caller[r] = "acked"

Answered(r) == ~owed[r]

StrandedOnMarker(r) == markedLate[r] /\ Covers(marker, asked[r])

FetchedWithoutBypass(r) == addLost[r] /\ fetchedSince[r]

RefreshAnsweredBeforeIdle ==
  Idle => \A r \in Requests : Acked(r) => Answered(r)

RefreshAnsweredUnlessMarkedLate ==
  Idle => \A r \in Requests :
            Acked(r) => Answered(r) \/ StrandedOnMarker(r)

RefreshAnsweredUnlessAddLost ==
  Idle => \A r \in Requests :
            Acked(r) => Answered(r) \/ FetchedWithoutBypass(r)

RefreshAnsweredOutsideKnownRaces ==
  Idle => \A r \in Requests :
            Acked(r) => Answered(r) \/ StrandedOnMarker(r)
                                    \/ FetchedWithoutBypass(r)

Symmetry == Permutations(Requests)
=============================================================================
