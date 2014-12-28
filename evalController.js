/*

Core compiler used to process Blockly blocks and update game models during execution of scripts.

@author Shraman Ray Chaudhuri
@author Paul Medlock-Walton

*/

// Initialize namespace and data structures for call stack execution
bd.evaluator.ctr = {};
bd.evaluator.ctr.configs = {};
bd.evaluator.ctr.callStack= [];
bd.evaluator.ctr.context = {};
bd.evaluator.ctr.callStackObjectsForTick = [];
bd.evaluator.ctr.stacksToEvaluate = [];
bd.evaluator.ctr.activeTimerIds = {};

// Intialize flags for control flow
bd.evaluator.ctr.stopEval = false;
bd.evaluator.ctr.blockExecutionError = false;
bd.evaluator.ctr.breakLoop = false;
bd.evaluator.ctr.functionReturn = false;
bd.evaluator.ctr.runEvalScript = false;

// Global variables and constants
bd.evaluator.ctr.evalCounter = 0;
var d = new Date();
bd.evaluator.ctr.timerStart = d.getTime()
/** @const */ bd.evaluator.ctr.MAX_CALLS = 150;


// ********************************************** //
// ********************************************** //
// ********* SCRIPT EXECUTION FUNCTIONS ********* //
// ********************************************** //
// ********************************************** //

/**
  Function called once to start continuous evaluation of blocks
*/
bd.evaluator.ctr.startGame = function() {

  // Check whether the game has been started previously
  if(!bd.model.getCurrentGame().started){
    var scriptPages = bd.model.getEntityList("scriptPage");
    bd.evaluator.ctr.runEvalScript = false;
    // Initialize "global varialbe" blocks
    for(var i=0;i<scriptPages.length;i++){
      bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"variables_init_global_type",[],{});
      bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"variables_init",[],{});
    }
    // Check whether automatic evaluation of scripts is enabled
    if(bd.evaluator.ctr.runEvalScript){
      bd.evaluator.ctr.initializeStack();
    }
    bd.evaluator.ctr.runEvalScript = false;
    for(var i=0;i<scriptPages.length;i++){
      bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"game_start",[],{});
    }
    if(bd.evaluator.ctr.runEvalScript){
      bd.evaluator.ctr.initializeStack();
    }
    // Initialize game model
    bd.model.startGame(bd.instanceId,bd.model.getPlayerId(),true);
  }

}

/**
  Function to handle asynchronous, dynamic player entry (MP mode only)
*/
bd.evaluator.ctr.whenPlayerJoins = function() {

  if(bd.model.isMultiplayer()) {
    var hasJoined = bd.model.entityLookup(bd.player.ctr.playerId).hasJoined;
    var context = {"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};
    var restrictionArray = [{titleName:"PLAYER",entityId:bd.player.ctr.playerId}];
    var scriptPages = bd.model.getEntityList("scriptPage");
    // Check all scripting pages for duplicate players
    for(var i=0;i<scriptPages.length;i++){
      if(!hasJoined) {
        restrictionArray.push({titleIndex:1,value:"JOIN"});
        bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"when_player_join",restrictionArray,context);
      } else {
        // Player rejoins
        restrictionArray.push({titleIndex:1,value:"REJOIN"});
        bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"when_player_join",restrictionArray,context);
      }
    }
    // Update the game model
    if(!hasJoined) {
      bd.model.addModelUpdateElement([bd.player.ctr.playerId],"set","hasJoined",true,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
      bd.model.sendUpdates();
    }
  }

}

/**
  Determine whether a given "event" block is triggered by external pointer blocks (under construction)

  @param {number} pointerId
  @param {block} block object that is being evaluated
  @param {string} fieldName pointer field name (to extract type of pointer)
  @return {boolean} true if given event block should be triggered
*/
bd.evaluator.ctr.isEventTriggeredByPointerId = function(pointerId,block,fieldName) {

  var fieldValue = bd.evaluator.ctr.getTitleTextFromBlock(fieldName,block);
  if(bd.util.containsPrefix(fieldValue,"pointer:")) {
    var pointerIdFromField = bd.util.removePrefix(fieldValue,"pointer");
    // Pointer block triggers any event on script page
    if(pointerIdFromField == "any") {
      return true;
    } else if (pointerIdFromField == "active") {
      var game = bd.component.lookup(bd.model.getCurrentViewId()).getPhaserGameObject();
      if(game.input.activePointer) {
        pointerIdFromField = game.input.activePointer.id;
      }
    }
    return (pointerIdFromField == pointerId);
  }
  return false;

}

/**
  Start-point of script evaluation of a given scripting panel in the game editor

  @param {number} entityIdWithScripts id of script page that holds current blocks to be executed
  @param {string} rootBlockName name of block where execution starts (usually an "event" block)
  @param {Array.<number|string>} titleIndexEntityIdCheckArray property id's of blocks to check, to match same root blocks on unseen script pages
  @param {Object.<string, string>} context local variables, originating script, flags, etc.
  @param {boolean} fromScript true if this script was called from a different script (e.g. function calls)
  @param {string} reference to parameter in previous call stack
  @param {boolean} addToStacksToEvaluate true if this script should be evaluated on the next clock cycle
  @param {boolean} returnFoundBlock true if function should return the root block
  @returns {block} root block if above flag is set to true, else null
*/
bd.evaluator.ctr.evalEntityScripts = function(entityIdWithScripts,rootBlockName,titleIndexEntityIdCheckArray,context,fromScript,paramRef,addToStacksToEvaluate,returnFoundBlock){

  // Find appropriate script page to search
  var entityWithScripts = bd.entityLookup[entityIdWithScripts];
  context["callingEntity"] = entityIdWithScripts;
  if(entityWithScripts.scriptObject != null && entityWithScripts.scriptObject != "" && entityWithScripts.scriptObject.xml != null && entityWithScripts.scriptObject.xml.block != null){
    var blockList;
    if(entityWithScripts.scriptObject.xml.block.length == null){
      blockList = [entityWithScripts.scriptObject.xml.block];
    } else {
      blockList = entityWithScripts.scriptObject.xml.block;
    }

    // Iterate through all blocks to find the correct script to execute
    for(var i=0;i<blockList.length;i++){
      if(blockList[i]._type == rootBlockName){
        // Check if piece click event is referring to the piece instance
        var isValidBlock = true;

        for(var k=0;k<titleIndexEntityIdCheckArray.length;k++){
          // Extract block information
          var titleIndex = titleIndexEntityIdCheckArray[k].titleIndex;
          var titleName = titleIndexEntityIdCheckArray[k].titleName;
          var entityId = titleIndexEntityIdCheckArray[k].entityId;
          var value = titleIndexEntityIdCheckArray[k].value;
          var pointerId =titleIndexEntityIdCheckArray[k].pointerId;

          // Run exhaustive block checking
          if(entityId != null){
            var entityText = "";
            if(titleIndex != null){
              entityText = blockList[i].field[titleIndex].__text
              if(!bd.evaluator.ctr.isEventTriggeredByEntity(entityText,entityId)){
                isValidBlock = false;
                break;
              }
            } else {
              var matchingEntityIds = bd.evaluator.ctr.entityTitleToEntityIdArray(titleName,blockList[i]);
              if(bd.model.entityLookup(entityId) == null){
                isValidBlock = false;
                break;
              }
              if(!bd.evaluator.ctr.isEventTriggeredByEntityNEW(matchingEntityIds,entityId)){
                isValidBlock = false;
                break;
              }
            }

          } else if(pointerId != null) {
            var triggeredByPointerId = bd.evaluator.ctr.isEventTriggeredByPointerId(pointerId,blockList[i],titleName);
            if(!triggeredByPointerId) {
              isValidBlock = false;
              break;
            }
          } else {
            if(titleIndex != null) {
              if(blockList[i].field.length != null && blockList[i].field[titleIndex].__text != value) {
                isValidBlock = false;
                break;
              } else if(blockList[i].field.length == null && blockList[i].field.__text != value){
                isValidBlock = false;
                break;
              }
            }
          }
        }

        // Return the found block, without further execution
        if(isValidBlock && returnFoundBlock) {
          return blockList[i];
        }

        // TODO: Change to avoid use of "typeof"
        if(typeof addToStacksToEvaluate != "undefined" && addToStacksToEvaluate) {
          if(isValidBlock){
            var newCallStack = [];
            var stackObject = {block:blockList[i],context:context};
            if(stackObject.block.next && stackObject.block.next.block){
              nextBlock = stackObject.block.next.block;
            }
            var secondStackObject = {block:nextBlock,context:stackObject.context};
            newCallStack.push(secondStackObject)
            bd.evaluator.ctr.stacksToEvaluate.push(newCallStack);
          }
        } else {

          // Determine whether scripts should stop or continue on function call (important for multi-threading)
          if(isValidBlock){
            if(fromScript){
              bd.evaluator.ctr.startNewStackWhileContinuingPrevious([{block:blockList[i],context:context,callingFunction:paramRef}])
            } else if(bd.evaluator.ctr.runEvalScript) {
              // Queue the other scripts with the same root block to execute on this clock cycle
              var anotherCallStackToExecute = [{block:blockList[i],context:context,callingFunction:null}];
              bd.evaluator.ctr.makeStackEvaluatable(anotherCallStackToExecute);
              bd.evaluator.ctr.callStackObjectsForTick.push(anotherCallStackToExecute);
            } else {
              bd.evaluator.ctr.addToCallStack({block:blockList[i],context:context,callingFunction:null},false);
              bd.evaluator.ctr.runEvalScript = true;
            }
          }

        }

        if(bd.evaluator.ctr.stopEval){
          break;
        }
      }
    }

  }

}

// ********************************************** //
// ********************************************** //
// ************ CALL STACK OPERATIONS *********** //
// ********************************************** //
// ********************************************** //

/**
  Add a block to the call stack for proper execution

  @param {Object.<string, block>} callObject the call stack operates on more information than just the block, hence the use of call objects
  @param {boolean} initializeStack true if block execution should happen right away
  @param {boolean} secondToLast true if the current block being executed is second to the last one in the script chain
*/
bd.evaluator.ctr.addToCallStack = function(callObject,initializeStack,secondToLast){

  if(initializeStack){
    bd.evaluator.ctr.callStack.push(callObject);
    bd.evaluator.ctr.initializeStack();
  } else {
    if(secondToLast){
      bd.evaluator.ctr.callStack.splice(bd.evaluator.ctr.callStack.length-1,0,callObject);
    } else {
      bd.evaluator.ctr.callStack.push(callObject);
    }
  }
}

/**
  Intermediate function to flag a stack for evaluation and deflag all other stacks
*/
bd.evaluator.ctr.initializeStack = function(){
  bd.evaluator.ctr.makeStackEvaluatable(bd.evaluator.ctr.callStack)
  bd.evaluator.ctr.evaluateStack();
}

/**
  Intermediate function to set flags based on the root block being evaluated
    (e.g. forever loops should initialize "break" to false)

  @param {Array.<callObject>} callStack an array of call objects to be executed
*/
bd.evaluator.ctr.makeStackEvaluatable  = function(callStack) {
  var stackObject = callStack[callStack.length-1];
  bd.evaluator.ctr.context = stackObject.context;
  var nextBlock = null;
  if(stackObject.block._type == "animation_def" ||
     stackObject.block._type == "forever_procedure" ||
     stackObject.block._type == "forever_loop" ||
     stackObject.block._type == "procedures_def"){

    // Check that the block exists AND has a next block to evaluate (otherwise these "header" blocks are moot)
    if(stackObject.block.statement && stackObject.block.statement.block){
      nextBlock = stackObject.block.statement.block;
    }

  } else {
    if(stackObject.block.next && stackObject.block.next.block){
      nextBlock = stackObject.block.next.block;
    }
  }
  callStack.push({block:nextBlock,context:stackObject.context});
  return callStack;
}

/**
  Adds an entire new call stack to the callStackObjectsForTick to execute in the same clock cycle
    (important for pausing user input and for single-threaded function calls)

  @param {Array.<callObject>} callStack an array of call objects to be executed
*/
bd.evaluator.ctr.addNewStackForTick = function(callStack) {
  bd.evaluator.ctr.makeStackEvaluatable(callStack);
  bd.evaluator.ctr.callStackObjectsForTick.push(callStack);
}

/**
  Start point for evaluation of an initialized call stack
*/
bd.evaluator.ctr.evaluateStack = function(){
  var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
  bd.evaluator.ctr.context = stackObject.context;
  bd.evaluator.ctr.evaluateBlock(stackObject.block);
}

/**
  Continues execution of call stack and updates the stack after every block execution

  @param {Object.<Object, block>} nextObject holding the next block to be executed, with extra variables for context (e.g. parameters)
*/
bd.evaluator.ctr.nextBlockInCallStack = function(nextObject){
  var blockForStack = null;
  if(nextObject && nextObject.block){
    blockForStack = nextObject.block;
  }
  bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1].block = blockForStack;
  bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1].params = null;
  bd.evaluator.ctr.evaluateStack();
}

/**
  Loads next block onto call stack without executing it

  @param {Object.<Object, block>} nextObject holding the next block to be executed, with extra variables for context (e.g. parameters)
*/
bd.evaluator.ctr.nextBlockInCallStackNoEvaluation = function(nextObject){
  var blockForStack = null;
  if(nextObject && nextObject.block){
    blockForStack = nextObject.block;
  }
  bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1].block= blockForStack;
  bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1].params = null;
}

/**
  Start point of pseudo-multi-threaded evaluation of function call scripts

  @param {Array.<callObject>} newStack an array of call objects to be executed on the new stack
*/
bd.evaluator.ctr.startNewStackWhileContinuingPrevious = function(newStack) {
  bd.evaluator.ctr.callStackObjectsForTick.push(bd.evaluator.ctr.callStack);
  bd.evaluator.ctr.callStack = newStack;
  bd.evaluator.ctr.initializeStack();
}

/**
  Execute the remainder of the original stack, after the interrupting procedural call
*/
bd.evaluator.ctr.continuePreviousStack = function() {
  if(bd.evaluator.ctr.callStackObjectsForTick.length != 0) {
    var newCallStack = bd.evaluator.ctr.callStackObjectsForTick.shift();
    bd.evaluator.ctr.callStack = newCallStack;
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    bd.evaluator.ctr.context = stackObject.context;
    bd.evaluator.ctr.evaluateBlock(stackObject.block);
  } else {
    bd.evaluator.ctr.evalCounter = 0;
  }
}

// ********************************************** //
// ********************************************** //
// *************** EVENT HANDLERS *************** //
// ********************************************** //
// ********************************************** //

/**
  Event handler for clicks on sprites

  @param {number} instanceId id number of piece clicked
*/
bd.evaluator.ctr.phaserPieceInstanceClicked = function(instanceId){
  var context = {"msg:VARIABLE_CLICKED_OBJECT":instanceId,"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};
  var entityId = bd.model.entityLookup(instanceId).parentId;
  var scriptPages = bd.model.getEntityList("scriptPage");
  var restrictionArray = [{titleName:"ENTITY",entityId:instanceId}];
  // MP mode must register clicks on all player's sprites
  if(bd.model.isMultiplayer()) {
    restrictionArray.push({titleName:"PLAYER",entityId:bd.player.ctr.playerId});
  }
  bd.evaluator.ctr.runEvalScript = false;
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"entity_clicked",restrictionArray,context);
  }
  if(bd.evaluator.ctr.runEvalScript){
    bd.evaluator.ctr.initializeStack();
  }
}

/**
  Event handler for key presses

  @param {number} keyCode standard key code of key pressed
*/
bd.evaluator.ctr.keyPressed = function(keyCode){
  var context = {"keyPressed":keyCode,"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};
  var scriptPages = bd.model.getEntityList("scriptPage");
  var restrictionArray = [{titleIndex:0,value:keyCode}];
  if(bd.model.isMultiplayer()) {
    restrictionArray.push({titleName:"PLAYER",entityId:bd.player.ctr.playerId});
  }

  bd.evaluator.ctr.runEvalScript = false;
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"key_pressed",restrictionArray,context);
  }
  if(bd.evaluator.ctr.runEvalScript){
    bd.evaluator.ctr.initializeStack();
  }

}

/**
  Event handler for reserved keys set by individual players

  @param {string} keyChar special character pressed
*/
bd.evaluator.ctr.customKeyPressed = function(keychar){
  var context = {"keyPressed":keychar,"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};
  var scriptPages = bd.model.getEntityList("scriptPage");
  var restrictionArray = [{titleIndex:0,value:keychar}];
  if(bd.model.isMultiplayer()) {
    restrictionArray.push({titleName:"PLAYER",entityId:bd.player.ctr.playerId});
  }

  bd.evaluator.ctr.runEvalScript = false;
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"custom_key_pressed",restrictionArray,context);
  }
  if(bd.evaluator.ctr.runEvalScript){
    bd.evaluator.ctr.initializeStack();
  }
}

/**
  Event handler collisions between sprites

  @param {string} id of sprite collidee 1
  @param {string} id of sprite collidee 2
*/
bd.evaluator.ctr.onPhaserPhysicsCollision = function(entityId1,entityId2){

  // Make sure the entities exist before detecting the collision
  if(bd.model.entityLookup(entityId1) == null || bd.model.entityLookup(entityId2) == null) {
    return;
  }
  var context = {"msg:VARIABLE_COLLIDEE_1":entityId1,"msg:VARIABLE_COLLIDEE_2":entityId2,"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};

  // Search through all script pages for root block to execute upon collision
  var scriptPages = bd.model.getEntityList("scriptPage");
  var restrictionArray = [{titleName:"ENTITY1",entityId:entityId1},{titleName:"ENTITY2",entityId:entityId2}]
  if(bd.model.isMultiplayer()) {
    restrictionArray.push({titleName:"PLAYER",entityId:bd.player.ctr.playerId});
  }

  bd.evaluator.ctr.runEvalScript = false;
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"when_phaser_physics_collide",restrictionArray,context);
  }
  if(bd.evaluator.ctr.runEvalScript){
    bd.evaluator.ctr.initializeStack();
  }

  // In case the scripts deleted an entity, check before trying to find scripts to evaluate
  if(bd.model.entityLookup(entityId1) == null || bd.model.entityLookup(entityId2) == null) {
    return;
  }

  // Load appropriate sprites involved in collision
  var context = {"msg:VARIABLE_COLLIDEE_1":entityId2,"msg:VARIABLE_COLLIDEE_2":entityId1,"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};

  var scriptPages = bd.model.getEntityList("scriptPage");
  restrictionArray = [{titleName:"ENTITY1",entityId:entityId2},{titleName:"ENTITY2",entityId:entityId1}]
  if(bd.model.isMultiplayer()) {
    restrictionArray.push({titleName:"PLAYER",entityId:bd.player.ctr.playerId});
  }

  bd.evaluator.ctr.runEvalScript = false;
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"when_phaser_physics_collide",restrictionArray,context);
  }
  if(bd.evaluator.ctr.runEvalScript){
    bd.evaluator.ctr.initializeStack();
  }

}

/**
  Event handler for collisions between sprites

  @param {number} id of sprite collidee
  @param {string} edge collided with ("top", "bottom", "left", "right")
*/
bd.evaluator.ctr.onEdgeCollision = function(entityId,edge) {

  if(bd.model.entityLookup(entityId) == null) {
    return;
  }
  var context = {"msg:VARIABLE_COLLIDEE":entityId,"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};
  var restrictionArray = [{titleName:"ENTITY",entityId:entityId},{titleIndex:1,value:edge}];
  if(bd.model.isMultiplayer()) {
    restrictionArray.push({titleName:"PLAYER",entityId:bd.player.ctr.playerId});
  }

  var scriptPages = bd.model.getEntityList("scriptPage");
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"when_collide_edge",restrictionArray,context);
  }

}

/**
  Event handler for pointer triggers (under construction)

  @param {number} id of pointer block that triggered the event
  @param {block} event block to be executed
*/
bd.evaluator.ctr.onPointerEvent = function(pointerId,event) {

  var context = {"msg:VARIABLE_POINTER":"pointer:" + pointerId,"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};
  var restrictionArray = [{titleName:"POINTER",pointerId:pointerId},{titleIndex:1,value:event}];
  if(bd.model.isMultiplayer()) {
    restrictionArray.push({titleName:"PLAYER",entityId:bd.player.ctr.playerId});
  }

  bd.evaluator.ctr.runEvalScript = false;
  var scriptPages = bd.model.getEntityList("scriptPage");
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"when_input_event",restrictionArray,context);
  }
  if(bd.evaluator.ctr.runEvalScript){
    bd.evaluator.ctr.initializeStack();
  }
}

/**
  Event handler for reaching the end of a video

  @param {number} videoInstanceId id of video object being played
*/
bd.evaluator.ctr.finishedVideo = function(videoInstanceId){
  var context = {"msg:VARIABLE_WATCHED_VIDEO":videoInstanceId,"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};

  var scriptPages = bd.model.getEntityList("scriptPage");

  bd.evaluator.ctr.runEvalScript = false;
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"when_video_finished",[{titleIndex:0,entityId:videoInstanceId},{titleIndex:1,entityId:bd.player.ctr.playerId}],context);
  }
  if(bd.evaluator.ctr.runEvalScript){
    bd.evaluator.ctr.initializeStack();
  }

}

/**
  Event handler for newly introduced sprites

  @param {number} instanceId id of newly placed sprite
  @param {number} startX x-coordinate of location placed (relative to the scripting iFrame!)
  @param {number} startY y-coordinate of location placed (relative to the scripting iFrame!)
*/
bd.evaluator.ctr.whenPhaserPhysicsPlaced = function(instanceId,startX,startY){
  var context = {"msg:VARIABLE_DROPPED_OBJECT":instanceId,"msg:VARIABLE_START_X":{type:"value",value:startX},"msg:VARIABLE_START_Y":{type:"value",value:startY},"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};

  var scriptPages = bd.model.getEntityList("scriptPage");
  var restrictionArray = [{titleName:"ENTITY",entityId:instanceId}];
  if(bd.model.isMultiplayer()) {
    restrictionArray.push({titleName:"PLAYER",entityId:bd.player.ctr.playerId});
  }

  bd.evaluator.ctr.runEvalScript = false;
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"when_phaser_piece_dropped",restrictionArray,context);
  }
  if(bd.evaluator.ctr.runEvalScript){
    bd.evaluator.ctr.initializeStack();
  }
}

// ********************************************** //
// ********************************************** //
// *********** HANDLER HELPER METHODS *********** //
// ********************************************** //
// ********************************************** //

bd.evaluator.ctr.beforeWhenDroppedOnGrid = function(beforeWhen,instanceId,gridId,column,row){
  if (beforeWhen === 'BEFORE') {
    var context = {"msg:VARIABLE_DROPPED_OBJECT":instanceId,"msg:VARIABLE_PlACED_GRID":gridId,"msg:VARIABLE_TARGET_COLUMN":{type:"value",value:column},"msg:VARIABLE_TARGET_ROW":{type:"value",value:row},"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};
  } else if (beforeWhen === 'WHEN') {
    var context = {"msg:VARIABLE_DROPPED_OBJECT":instanceId,"msg:VARIABLE_PlACED_GRID":gridId,"msg:VARIABLE_PREVIOUS_COLUMN":{type:"value",value:column},"msg:VARIABLE_PREVIOUS_ROW":{type:"value",value:row},"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};
  }
  var scriptPages = bd.model.getEntityList("scriptPage");
  var restrictionArray = [{titleIndex:0,value:beforeWhen},{titleName:"ENTITY",entityId:instanceId},{titleName:"GRID",entityId:gridId}];
  if(bd.model.isMultiplayer()) {
    restrictionArray.push({titleName:"PLAYER",entityId:bd.player.ctr.playerId});
  }

  bd.evaluator.ctr.runEvalScript = false;
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"grid_event_entity_dropped",restrictionArray,context);
  }
  if(bd.evaluator.ctr.runEvalScript){
    bd.evaluator.ctr.initializeStack();
  }
}

bd.evaluator.ctr.beforeWhenRemovedFromGrid = function(beforeWhen,instanceId,gridId,columnOrX,rowOrY){
  if (beforeWhen === 'BEFORE') {
    var context = {"msg:VARIABLE_REMOVED_OBJECT":instanceId,"msg:VARIABLE_REMOVED_GRID":gridId,"msg:VARIABLE_TARGET_X":{type:"value",value:columnOrX},"msg:VARIABLE_TARGET_Y":{type:"value",value:rowOrY},"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};
  } else if (beforeWhen === 'WHEN') {
    var context = {"msg:VARIABLE_REMOVED_OBJECT":instanceId,"msg:VARIABLE_REMOVED_GRID":gridId,"msg:VARIABLE_PREVIOUS_COLUMN":{type:"value",value:columnOrX},"msg:VARIABLE_PREVIOUS_ROW":{type:"value",value:rowOrY},"msg:VARIABLE_PLAYER":bd.player.ctr.playerId};
  }
  var scriptPages = bd.model.getEntityList("scriptPage");
  var restrictionArray = [{titleIndex:0,value:beforeWhen},{titleName:"ENTITY",entityId:instanceId},{titleName:"GRID",entityId:gridId}];
  if(bd.model.isMultiplayer()) {
    restrictionArray.push({titleName:"PLAYER",entityId:bd.player.ctr.playerId});
  }

  bd.evaluator.ctr.runEvalScript = false;
  for(var i=0;i<scriptPages.length;i++){
    bd.evaluator.ctr.evalEntityScripts(scriptPages[i].id,"grid_event_entity_removed",restrictionArray,context);
  }
  if(bd.evaluator.ctr.runEvalScript){
    bd.evaluator.ctr.initializeStack();
  }
}

bd.evaluator.ctr.beforeWhenPlaced = function(beforeOrWhen,pieceInstanceId,targetId){
  //console.log("before when placed");
  var context = {"placedPiece":pieceInstanceId,"placedTarget":targetId,"player":bd.player.ctr.playerId};
  bd.evaluator.ctr.stopEval = false;

  var pieceId = bd.entityLookup[pieceInstanceId].parentId;
  if(targetId == null){
    bd.evaluator.ctr.evalEntityScripts(pieceId,"piece_dropped",[{titleIndex:0,value:beforeOrWhen},{titleName:"ENTITY",entityId:pieceInstanceId},{titleName:"PLAYER",entityId:bd.player.ctr.playerId}],context);

    //go through each of the player script objects
    if(bd.evaluator.ctr.stopEval){return};
    bd.evaluator.ctr.evalEntityScripts(bd.player.ctr.playerId,"piece_dropped",[{titleIndex:0,value:beforeOrWhen},{titleName:"ENTITY",entityId:pieceInstanceId},{titleName:"PLAYER",entityId:bd.player.ctr.playerId}],context);

  } else {

    //piece placed on targets
    bd.evaluator.ctr.evalEntityScripts(pieceId,"piece_dropped_on_target",[{titleIndex:0,value:beforeOrWhen},{titleName:"ENTITY",entityId:pieceInstanceId},{titleName:"PLAYER",entityId:bd.player.ctr.playerId},{titleName:"TARGET",entityId:targetId}],context);

    var pathId = bd.entityLookup[targetId].parentId;
    if(bd.evaluator.ctr.stopEval){return};
    bd.evaluator.ctr.evalEntityScripts(pathId,"piece_dropped_on_target",[{titleIndex:0,value:beforeOrWhen},{titleName:"ENTITY",entityId:pieceInstanceId},{titleName:"PLAYER",entityId:bd.player.ctr.playerId},{titleName:"TARGET",entityId:targetId}],context);

    if(bd.evaluator.ctr.stopEval){return};
    bd.evaluator.ctr.evalEntityScripts(bd.player.ctr.playerId,"piece_dropped_on_target",[{titleIndex:0,value:beforeOrWhen},{titleName:"ENTITY",entityId:pieceInstanceId},{titleName:"PLAYER",entityId:bd.player.ctr.playerId},{titleName:"TARGET",entityId:targetId}],context);
  }

}

bd.evaluator.ctr.isEntityIdOfParentEntity = function(titleName,block){

  var entityText = bd.evaluator.ctr.getTitleTextFromBlock(titleName,block)

  if(entityText == null){
    return false;
  }
  if(bd.util.containsPrefix(entityText,"id")){
    var entityId = bd.util.removeIdPrefix(entityText);
    if(bd.entityLookup[entityId].instanceIds != null){
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

// ********************************************** //
// ********************************************** //
// *************** BLOCK CONFIGS **************** //
// ********************************************** //
// ********************************************** //

/**

    Block configurations are objects inside of a "configs" array
  containing all information about what happens when a "block" gets
  "executed". They are designed as independent units that carry
  the only information needed for successful execution of blocks in a
  script. This allows for maintainability, as the only requirement
  for expansion of the set of blocks in the system is adding another
  one of the "config" units below.

  Block configurations typically have the following information:

    - paramsInfo: an array of objects that contain information about
      the parameters that the block needs from its fields, dropdowns, and
      input sockets

    - evalFunc: the heavy-lifting function that the block performs on the
      system to update the game model

    The rationale for this design choice was to have a compact compiler
  core that would take in independent units and process them the same way
  regardless of their specific functionality or representation.

*/

// ********************************************** //
// ********************************************** //
// **** HYBRID BLOCKS (RETURN VALUE MUTATOR) **** //
// ********************************************** //
// ********************************************** //

bd.evaluator.ctr.configs["add_to_list"] = {
  paramsInfo  : [{name:"currentList",type:"value",valueName:"LIST"},
                 {name:"val",type:"value",valueName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var value = stackObject.params.val;
    var currentList = stackObject.params.currentList;
    if (block.mutation.hasOutput){
      var newList = currentList.slice(0)
      newList.push(value)
      bd.evaluator.ctr.returnHandler(newList,block.returnsEntity);
    } else {
      currentList.push(value)
      bd.evaluator.ctr.nextBlockInCallStack(block.next)
    }
  }
};

bd.evaluator.ctr.configs["insert_into_list"] = {
  paramsInfo  : [{name:"currentList",type:"value",valueName:"LIST"},
                 {name:"val",type:"value",valueName:"VAR"},
                 {name:"listIndex",type:"value",valueName:"INDEX"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var value = stackObject.params.val;
    var currentList = stackObject.params.currentList;
    var index = Math.floor(stackObject.params.listIndex) - 1;
    if (index < 0) {
      index = 0;
    } else if (index > currentList.length) {
      index = currentList.length;
    }
    if (block.mutation.hasOutput) {
      var newList = currentList.slice(0);
      newList.splice(index,0,value);
      bd.evaluator.ctr.returnHandler(newList,block.returnsEntity);
    } else {
      currentList.splice(index,0,value);
      bd.evaluator.ctr.nextBlockInCallStack(block.next);
    }
  }
};

bd.evaluator.ctr.configs["change_item_from_list"] = {
  paramsInfo  : [{name:"currentList",type:"value",valueName:"LIST"},
                 {name:"val",type:"value",valueName:"VAR"},
                 {name:"listIndex",type:"value",valueName:"INDEX"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var value = stackObject.params.val;
    var currentList = stackObject.params.currentList;
    var index = Math.floor(stackObject.params.listIndex) - 1;
    if (index < 0) {
      index = 0;
    } else if (index >= currentList.length) {
      index = currentList.length - 1;
    }
    if (block.mutation.hasOutput) {
      var newList = currentList.slice(0);
      newList.splice(index,1,value);
      bd.evaluator.ctr.returnHandler(newList,block.returnsEntity);
    } else {
      currentList.splice(index,1,value);
      bd.evaluator.ctr.nextBlockInCallStack(block.next);
    }
  }
};

bd.evaluator.ctr.configs["remove_from_list"] = {
  paramsInfo  : [{name:"currentList",type:"value",valueName:"LIST"},
                 {name:"val",type:"value",valueName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var value = stackObject.params.val;
    var currentList = stackObject.params.currentList;
    var removeItem = function(list){
      for (var i=0;i<list.length;i++){
        if (list[i] == value){
          list.splice(i,1);
          break;
        }
      }
    }
    if (block.mutation.hasOutput) {
      var newList = currentList.slice(0);
      removeItem(newList);
      bd.evaluator.ctr.returnHandler(newList,block.returnsEntity);
    } else {
      removeItem(currentList);
      bd.evaluator.ctr.nextBlockInCallStack(block.next);
    }
  }
};

bd.evaluator.ctr.configs["shuffle_list"] = {
  paramsInfo  : [{name:"currentList",type:"value",valueName:"LIST"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var shuffle = function(v){
      for(var j, x, i = v.length; i; j = parseInt(Math.random() * i), x = v[--i], v[i] = v[j], v[j] = x);
        return v;
    };
    var currentList = stackObject.params.currentList;
    if (block.mutation.hasOutput) {
      var tempList = currentList.slice(0);
      var newList = [];
      for (var i=tempList.length - 1;i>=0;i--){
        var k = Math.floor(Math.random()*tempList.length);
        newList.push(tempList.splice(k,1)[0]);
      }
      bd.evaluator.ctr.returnHandler(newList,block.returnsEntity);
    } else {
      shuffle(currentList);
      bd.evaluator.ctr.nextBlockInCallStack(block.next)
    }
  }
};

// ********************************************** //
// ********************************************** //
// ***** BLOCKS WITH OUTPUT (RETURN VALUES) ***** //
// ********************************************** //
// ********************************************** //

bd.evaluator.ctr.configs["clone_to_xy_return"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"viewIdArray",type:"entity",fieldName:"VIEW"},
                 {name:"xValue",type:"value",valueName:"X"},
                 {name:"yValue",type:"value",valueName:"Y"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var cloneIds = [];
    var isEntityClass = false;
    var entityId = stackObject.params.entityIdArray[0];
    var entityFromPrefix = bd.model.entityLookup(entityId);

    //check if is class or instance
    if(bd.model.entityParentNameToChildName[entityFromPrefix.type] != null){
      isEntityClass = true;
      var entityClass = entityFromPrefix;
      var childTypeName = bd.model.entityParentNameToChildName[entityClass.type];
      var childConstructor = bd.component.typeNameToComponent[childTypeName].constructor;

      if(entityClass.shareMode == "perPlayer"){
      //get player ids
        var playerIdArray = bd.evaluator.ctr.entityTitleToEntityIdArray("ENTITY_PLAYER",block);
        for(var i=0;i<playerIdArray.length;i++){
          var newEntity = new childConstructor(null,entityId,null,playerIdArray[i],playerIdArray[i]);
          //bd.model.addEntityToLookup(newEntity.id,newEntity);
          cloneIds.push(newEntity.id);
        }
      } else if(entityClass.shareMode == "local"){
        var newEntity = new childConstructor(null,entityId,null,bd.player.ctr.playerId,bd.player.ctr.playerId);
        cloneIds.push(newEntity.id);

      } else if(entityClass.shareMode == "share"){
        var newEntity = new childConstructor(null,entityId,null,null,null);
        //bd.model.addEntityToLookup(newEntity.id,newEntity);
        cloneIds.push(newEntity.id);
      }
    }

    //is instance
    if(!isEntityClass){
      //get id (using normal method)
      var entityIds = stackObject.params.entityIdArray;
      for(var i=0;i<entityIds.length;i++){
        var entityId = entityIds[i];
        var entity = bd.model.entityLookup(entityId);
        var entityConstructor = bd.component.typeNameToComponent[entity.type].constructor;
        if(entity.shareMode == "perPlayer" || entity.shareMode == "local"){
          //create instance per player
          var newEntity = new entityConstructor(null,entity.parentId,entity,entity.playerId,entity.visibleToPlayerId);
          cloneIds.push(newEntity.id);
        } else {
          //create instance
          var newEntity = new entityConstructor(null,entity.parentId,entity,null,null);
          cloneIds.push(newEntity.id);
        }

      }

    }


    var oldViewId = newEntity.model.viewId
    //for each clone set x,y
    var viewId = stackObject.params.viewIdArray[0];

    //TODO should get layer from block, instead we'll cheat for now and get the top entity layer
    var layerIds = bd.component.lookup(viewId).getLayerIds();
    var layerId = null;
    for(var i=layerIds.length-1;i>=0;i--) {
      //TODO, don't assume it's an entity layer
      if(bd.component.lookup(layerIds[i]).type == "tmxEntityLayer") {
        layerId = layerIds[i];
        break;
      }
    }

    var xValue = stackObject.params.xValue;
    var yValue = stackObject.params.yValue;
    if(oldViewId != viewId) {
      bd.model.addModelUpdateElement(cloneIds,"set","viewId",viewId,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    }
    bd.model.addModelUpdateElement(cloneIds,"set","layerId",layerId,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.addModelUpdateElement(cloneIds,"set","x",xValue,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.addModelUpdateElement(cloneIds,"set","y",yValue,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});

    for(var i=0;i<cloneIds.length;i++){
      var entityArrayName = bd.model.entityLookup(cloneIds[i]).type + "Ids";
      var shouldPropagate = true;
      if(bd.model.entityLookup(cloneIds[i]).shareMode == "local") {
        shouldPropagate = false;
      }
      bd.model.addModelUpdateElement([layerId],"push","entityIds",cloneIds[i],{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:true,updateUIInEditor:false,shouldPropagate:shouldPropagate});
      if(oldViewId != viewId) {
        if(oldViewId != null) {
          bd.model.addModelUpdateElement([oldViewId],"removeValue",entityArrayName,cloneIds[i],{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:true,updateUIInEditor:false,shouldPropagate:shouldPropagate});
        }
        bd.model.addModelUpdateElement([viewId],"push",entityArrayName,cloneIds[i],{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:true,updateUIInEditor:false,shouldPropagate:shouldPropagate});
      }

    }
    bd.model.sendUpdates();
    bd.model.addTraitsToEntities(cloneIds);
    bd.evaluator.ctr.returnHandler(cloneIds[0],block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["create_list"] = {
  getParams  : function(block){
    var paramsInfoArray = [];
    for(var i=0;i<parseInt(block.mutation._nums);i++) {
      paramsInfoArray.push({name:"ADD"+i,type:"value",valueName:"ADD"+i});
    }
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var createdList = [];
    for(var i=0;i<parseInt(block.mutation._nums);i++) {
      if(stackObject.params["ADD" + i] != null){
        createdList.push(stackObject.params["ADD" + i]);
      }
    }
    bd.evaluator.ctr.returnHandler(createdList,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["is_entity_in_game"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityId = stackObject.params.entityIdArray[0];
    var bool = (bd.model.entityLookup(entityId) != null);
    bd.evaluator.ctr.returnHandler(bool,block.returnsEntity);

  }
};

bd.evaluator.ctr.configs["get_pass_through"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityId = stackObject.params.entityIdArray[0];
    bd.evaluator.ctr.returnHandler(bd.model.entityLookup(entityId).passthrough,block.returnsEntity);

  }
};

bd.evaluator.ctr.configs["get_can_move"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityId = stackObject.params.entityIdArray[0];
    bd.evaluator.ctr.returnHandler(bd.model.entityLookup(entityId).movable,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["grid_is_entity_on_grid"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"gridIdArray",type:"entity",fieldName:"GRID"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityId = stackObject.params.entityIdArray[0];
    var sprites = []
    if (bd.component.lookup(entityId).classOrInstance == "class") {
      for (var i=0;i<bd.component.lookup(entityId).model.instanceIds.length;i++) {
        sprites.push(bd.component.lookup(bd.component.lookup(entityId).model.instanceIds[i]))
      }
    } else {
      sprites.push(bd.component.lookup(entityId))
    }
    var grid = bd.component.lookup(stackObject.params.gridIdArray[0]);
    var bool = false;
    for (var i=0;i<sprites.length;i++) {
      var sprite = sprites[i]
      if (sprite.getCurrentGrid() === grid.model){
        bool = true
      }
    }
    bd.evaluator.ctr.returnHandler(bool,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["grid_is_entity_at_location"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"gridIdArray",type:"entity",fieldName:"GRID"},
                 {name:"column",type:"value",valueName:"COL"},
                 {name:"row",type:"value",valueName:"ROW"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityId = stackObject.params.entityIdArray[0];
    var sprites = []
    if (bd.component.lookup(entityId).classOrInstance == "class") {
      for (var i=0;i<bd.component.lookup(entityId).model.instanceIds.length;i++) {
        sprites.push(bd.component.lookup(bd.component.lookup(entityId).model.instanceIds[i]))
      }
    } else {
      sprites.push(bd.component.lookup(entityId))
    }
    var grid = bd.component.lookup(stackObject.params.gridIdArray[0]);
    var column = Math.floor(stackObject.params.column)-1;
    var row = Math.floor(stackObject.params.row)-1;
    var bool = false;
    for (var i=0;i<sprites.length;i++){
      var sprite = sprites[i]
      if (sprite.getCurrentGrid() === grid.model) {
        if ((sprite.getCurrentColumnOrRow()['COLUMN'] === column) && (sprite.getCurrentColumnOrRow()['ROW'] === row)){
          bool = true;
        }
      }
    }
    bd.evaluator.ctr.returnHandler(bool,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["list_contains"] = {
  paramsInfo  : [{name:"val",type:"value",valueName:"VAR"},
                 {name:"currentList",type:"value",valueName:"LIST"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var currentList = stackObject.params.currentList;
    var value = stackObject.params.val;

    var bool = false;
    for(var i=0;i<currentList.length;i++){
      if(currentList[i] == value) {
        bool = true;
      }
    }
    bd.evaluator.ctr.returnHandler(bool,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["is_key_pressed"] = {
  paramsInfo  : [{name:"keyCode",type:"field",fieldName:"KEY_PRESSED"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var keyCode = stackObject.params.keyCode; //left,right
    var viewComponentObject = bd.component.lookup(bd.model.getCurrentViewId());
    if(!viewComponentObject.isInitialized) {
      bd.evaluator.ctr.returnHandler(false,block.returnsEntity);
      return;
    }

    if(viewComponentObject.type == "melonView") {
      var viewWindow = viewComponentObject.getWindow()
      if(viewWindow.me != null) {
        //condense when not debugging
        if(viewWindow.me.input.isKeyPressed('keyCode:' + keyCode)) {
          bd.evaluator.ctr.returnHandler(true,block.returnsEntity);
        } else {
          bd.evaluator.ctr.returnHandler(false,block.returnsEntity);
        }
      } else {
        bd.evaluator.ctr.returnHandler(false,block.returnsEntity);
      }
    } else if(viewComponentObject.type == "phaserView") {
        var phaserGameObject = viewComponentObject.getPhaserGameObject();
        var phaserObject = viewComponentObject.getPhaserObject();
        bd.evaluator.ctr.returnHandler(phaserGameObject.input.keyboard.isDown(keyCode),block.returnsEntity);
    }
  }
};

bd.evaluator.ctr.configs["is_custom_key_pressed"] = {
  paramsInfo  : [{name:"keyCode",type:"field",fieldName:"KEY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var keyCode = stackObject.params.keyCode.charCodeAt(0);
    var viewComponentObject = bd.component.lookup(bd.model.getCurrentViewId());
    if(!viewComponentObject.isInitialized) {
      bd.evaluator.ctr.returnHandler(false,block.returnsEntity);
      return;
    }

    if(viewComponentObject.type == "melonView") {
      var viewWindow = viewComponentObject.getWindow()
      if(viewWindow.me != null) {
        //condense when not debugging
        if(viewWindow.me.input.isKeyPressed('keyCode:' + keyCode)) {
          bd.evaluator.ctr.returnHandler(true,block.returnsEntity);
        } else {
          bd.evaluator.ctr.returnHandler(false,block.returnsEntity);
        }
      } else {
        bd.evaluator.ctr.returnHandler(false,block.returnsEntity);
      }
    } else if(viewComponentObject.type == "phaserView") {
        var phaserGameObject = viewComponentObject.getPhaserGameObject();
        var phaserObject = viewComponentObject.getPhaserObject();
        bd.evaluator.ctr.returnHandler(phaserGameObject.input.keyboard.isDown(keyCode),block.returnsEntity);
    }
  }
};

bd.evaluator.ctr.configs["list_length"] = {
  paramsInfo  : [{name:"list",type:"value",valueName:"LIST"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    bd.evaluator.ctr.returnHandler(stackObject.params.list.length,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["item_from_list"] = {
  paramsInfo  : [{name:"listIndex",type:"value",valueName:"INDEX"},
                 {name:"currentList",type:"value",valueName:"LIST"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var index = Math.floor(stackObject.params.listIndex);
    var currentList = stackObject.params.currentList;
    if (currentList.length == 0) {
      bd.evaluator.ctr.returnHandler("nullObject",block.returnsEntity);
    } else if (index > currentList.length) {
      bd.evaluator.ctr.returnHandler(currentList[currentList.length - 1],block.returnsEntity);
    } else if (index < 1) {
      bd.evaluator.ctr.returnHandler(currentList[0],block.returnsEntity);
    } else {
      bd.evaluator.ctr.returnHandler(currentList[index-1],block.returnsEntity);
    }
  }
};

bd.evaluator.ctr.configs["get_width_height"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"dimension",type:"field",fieldName:"DIMENSION"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var dimension = stackObject.params.dimension;
    var entityId = stackObject.params.entityIdArray[0];
    bd.evaluator.ctr.returnHandler(bd.model.entityLookup(entityId)[dimension],block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["trait_value"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"traitDefIdArray",type:"entity",fieldName:"TRAIT"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIds = stackObject.params.entityIdArray;
    var entityId = entityIds[0];
    var traitDefId = stackObject.params.traitDefIdArray[0];
    var entityTraitIds = bd.entityLookup[entityId].traitIds;

    var v = -1;
    for(var i=0;i<entityTraitIds.length;i++){
      if(bd.entityLookup[entityTraitIds[i]].traitDefId == traitDefId){
        v = bd.entityLookup[entityTraitIds[i]].value;
        break;
      }
    }
    bd.evaluator.ctr.returnHandler(v,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["math_max_min"] = {
  getParams   : function(block){
    var paramsInfoArray = [];
    // For value inputs
    for(var i=0, input;input = block.mutation._nums[i];i++){
      paramsInfoArray.push({name:input._name,type:"value",valueName:"ADD"+i});
    }
    // For operation field
    paramsInfoArray.push({name:"operation",type:"field",fieldName:"OP"});
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var operation = stackObject.params.operation;
    var numList = [];
    for(var i=0, input;input = block.mutation._nums[i];i++) {
      if(stackObject.params[input._name]){
        numList.push(stackObject.params[input._name]);
      }
    }
    if(numList == []) {
      //TODO: throw debug warning
      bd.evaluator.ctr.returnHandler(0,block.returnsEntity);
      return;
    } else {
      switch(operation) {
        case "MAX":
          bd.evaluator.ctr.returnHandler(Math.max.apply(null, numList),block.returnsEntity);
          return;
        case "MIN":
          bd.evaluator.ctr.returnHandler(Math.min.apply(null, numList),block.returnsEntity);
          return;
      }
    }
  }
};

bd.evaluator.ctr.configs["costume_num"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var entityId = entityIdArray[0];
    var costumeId = bd.entityLookup[entityId].costumeId;
    var costumeIdList = bd.component.lookup(entityId).getCostumeIds();
    var costumeNum = 0;
    for(var i=0;i<costumeIdList.length;i++){
      if(costumeId == costumeIdList[i]){
        costumeNum = i + 1;
        break;
      }
    }
    bd.evaluator.ctr.returnHandler(costumeNum,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["controls_parameter"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    bd.evaluator.ctr.returnHandler(entityIdArray[0],block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["all_instances_of"] = {
  paramsInfo  :[{name:"entityIdArray",type:"entity",fieldName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var instanceIds = bd.component.lookup(entityIdArray[0]).model.instanceIds
    var classIds = []
    for (var i=0;i<instanceIds.length;i++){
      if (bd.entityLookup[instanceIds[i]].playerId != null){
        classIds.push(instanceIds[i])
      }
    }
    bd.evaluator.ctr.returnHandler(classIds,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["math_random_int"] = {
  paramsInfo  : [{name:"low",type:"value",valueName:"FROM"},
                 {name:"high",type:"value",valueName:"TO"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var low = stackObject.params.low;
    var high = stackObject.params.high;
    if(low > high) {
      bd.evaluator.ctr.returnHandler(Math.floor(low),block.returnsEntity);
    } else {
      bd.evaluator.ctr.returnHandler(Math.floor(Math.random() * (high - low + 1) + low),block.returnsEntity);
    }
  }
};

bd.evaluator.ctr.configs["logic_boolean"] = {
  paramsInfo  : [{name:"trueOrFalse",type:"field",fieldName:"BOOL"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var trueOrFalse = stackObject.params.trueOrFalse;
    var bool = (trueOrFalse == "TRUE");
    bd.evaluator.ctr.returnHandler(bool,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["is_visible"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var entityId = entityIdArray[0];

    bd.evaluator.ctr.returnHandler(bd.entityLookup[entityId].visible,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["is_touching_phaser_physics"] = {
  getParams   : function(block){
    var paramsInfoArray = [];
    paramsInfoArray.push({name:"entityIdArray1",type:"entity",fieldName:"ENTITY1"});
    if(bd.evaluator.ctr.isEntityIdOfParentEntity("ENTITY2",block)){
      paramsInfoArray.push({name:"entityIdArray2",type:"entityClass",fieldName:"ENTITY2"});
    } else {
      paramsInfoArray.push({name:"entityIdArray2",type:"entity",fieldName:"ENTITY2"});
    }
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    //entity1 is specific instances only, and entity2 can be general
    var entityIdArray1 = stackObject.params.entityIdArray1;
    var entityIdArray2 = stackObject.params.entityIdArray2;
    var entityIdArray2PlayerMatched = [];
    if(bd.evaluator.ctr.isEntityIdOfParentEntity("ENTITY2",block)){
      for(var i=0;i<entityIdArray2.length;i++){
        if(bd.model.entityLookup(entityIdArray2[i]).playerId == bd.player.ctr.playerId){
          entityIdArray2PlayerMatched.push(entityIdArray2[i]);
        }
      }
    } else {
      entityIdArray2PlayerMatched = entityIdArray2;
    }
    var entityId1 = entityIdArray1[0];
    bd.evaluator.ctr.returnHandler(bd.component.lookup(entityId1).isTouching(entityIdArray2PlayerMatched),block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["is_touching_edge"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"edge",type:"field",fieldName:"EDGE"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var edge = stackObject.params.edge;
    bd.evaluator.ctr.returnHandler(bd.component.lookup(entityIdArray[0]).isTouchingEdge(edge),block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["is_touching_phaser_physics_edge"] = {
  getParams   : function(block){
    var paramsInfoArray = [];
    paramsInfoArray.push({name:"entityIdArray1",type:"entity",fieldName:"ENTITY1"});
    paramsInfoArray.push({name:"edge",type:"field",fieldName:"EDGE"});
    if(bd.evaluator.ctr.isEntityIdOfParentEntity("ENTITY2",block)){
      paramsInfoArray.push({name:"entityIdArray2",type:"entityClass",fieldName:"ENTITY2"});
    } else {
      paramsInfoArray.push({name:"entityIdArray2",type:"entity",fieldName:"ENTITY2"});
    }
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    //entity1 is specific instances only, and entity2 can be general
    var entityIdArray1 = stackObject.params.entityIdArray1;
    var entityIdArray2 = stackObject.params.entityIdArray2;
    var entityIdArray2PlayerMatched = [];
    var edge = stackObject.params.edge;
    if(bd.evaluator.ctr.isEntityIdOfParentEntity("ENTITY2",block)){
      for(var i=0;i<entityIdArray2.length;i++){
        if(bd.model.entityLookup(entityIdArray2[i]).playerId == bd.player.ctr.playerId){
          entityIdArray2PlayerMatched.push(entityIdArray2[i]);
        }
      }
    } else {
      entityIdArray2PlayerMatched = entityIdArray2;
    }
    var entityId1 = entityIdArray1[0];

    var bool = bd.component.lookup(entityId1).isTouchingPhaserPhysicsPieceEdge(entityIdArray2PlayerMatched, edge);
    bd.evaluator.ctr.returnHandler(bool,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["can_be_dragged"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var entityId = entityIdArray[0];

    bd.evaluator.ctr.returnHandler(bd.entityLookup[entityId].draggable,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["is_null"] = {
  paramsInfo  : [{name:"val",type:"value",valueName:"ENTITY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var value = stackObject.params.val;
    var bool = (value == "nullObject");
    bd.evaluator.ctr.returnHandler(bool,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["logic_compare"] = {
  getParams   : function(block){
    var paramsInfoArray = [];
    paramsInfoArray.push({name:"comparator",type:"field",fieldName:block.field._name});
    if(bd.util.isArray(block.value)){
      paramsInfoArray.push({name:"val1",type:"value",valueName:block.value[0]._name});
      paramsInfoArray.push({name:"val2",type:"value",valueName:block.value[1]._name});
    } else if(block.value) {
      paramsInfoArray.push({name:"val1",type:"value",valueName:block.value._name})
    }
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var comparator = stackObject.params.comparator;

    if(stackObject.params.val1 == "nullObject"){
      //TODO: throw debug warning, both sockets empty, returning false
      bd.evaluator.ctr.returnHandler(false,block.returnsEntity);
      return;
    } else {
      if(stackObject.params.val2 == "nullObject"){
        //TODO: throw debug warning, socket default to false
        stackObject.params.val2 = false;
      }

      switch(comparator){
        case "EQ":
          var bool = (stackObject.params.val1 == stackObject.params.val2);
          break;
        case "LT":
          var bool = (stackObject.params.val1 < stackObject.params.val2);
          break;
        case "LTE":
          var bool = (stackObject.params.val1 <= stackObject.params.val2);
          break;
        case "GT":
          var bool = (stackObject.params.val1 > stackObject.params.val2);
          break;
        case "GTE":
          var bool = (stackObject.params.val1 >= stackObject.params.val2);
          break;
        case "NEQ":
          var bool = (stackObject.params.val1 != stackObject.params.val2);
          break;
        default:
          var bool = false;
      }
    }
    bd.evaluator.ctr.returnHandler(bool,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["logic_operation"] = {
  getParams   : function(block){
    var paramsInfoArray = [];
    paramsInfoArray.push({name:"andOr",type:"field",fieldName:block.field._name});
    if(bd.util.isArray(block.value)){
      paramsInfoArray.push({name:"val1",type:"value",valueName:block.value[0]._name});
      paramsInfoArray.push({name:"val2",type:"value",valueName:block.value[1]._name});
    } else if(block.value) {
      paramsInfoArray.push({name:"val1",type:"value",valueName:block.value._name})
    }
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var andOr = stackObject.params.andOr;

    if(stackObject.params.val1 == "nullObject"){
      //TODO: throw debug warning, both sockets empty, returning false
      bd.evaluator.ctr.returnHandler(false,block.returnsEntity);
      return;
    } else {
      if(stackObject.params.val2 == "nullObject"){
        //TODO: throw debug warning, empty socket default to false
        stackObject.params.val2 = false;
      }

      switch(andOr){
        case "AND":
          var bool = (stackObject.params.val1 && stackObject.params.val2);
          break;
        case "OR":
          var bool = (stackObject.params.val1 || stackObject.params.val2);
          break;
        default:
          var bool = false;
      }
    }
    bd.evaluator.ctr.returnHandler(bool,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["math_arithmetic"] = {
  getParams   : function(block){
    var paramsInfoArray = [];
    paramsInfoArray.push({name:"operation",type:"field",fieldName:block.field._name});
    if(bd.util.isArray(block.value)){
      paramsInfoArray.push({name:"val1",type:"value",valueName:block.value[0]._name});
      paramsInfoArray.push({name:"val2",type:"value",valueName:block.value[1]._name});
    } else if(block.value) {
      paramName = (block.value._name == 'A' ? "val1" : "val2");
      paramsInfoArray.push({name:paramName,type:"value",valueName:block.value._name})
    }
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var operation = stackObject.params.operation;
    if(stackObject.params.val1 == "nullObject" && stackObject.params.val2 == "nullObject"){
      //TODO: throw debug warning, both sockets empty, returning 0
      bd.evaluator.ctr.returnHandler(0,block.returnsEntity);
      return;
    } else {
      if(stackObject.params.val1 == "nullObject"){
        //TODO: throw debug warning, empty socket 1 defaulted to 0
        stackObject.params.val1 = 0;
      }
      if(stackObject.params.val2 == "nullObject"){
        //TODO: throw debug warning, empty socket 2 defaulted to 0
        stackObject.params.val2 = 0;
      }
      switch(operation){
        case "ADD":
          var num = stackObject.params.val1 + stackObject.params.val2;
          break;
        case "MINUS":
          var num = stackObject.params.val1 - stackObject.params.val2;
          break;
        case "MULTIPLY":
          var num = stackObject.params.val1 * stackObject.params.val2;
          break;
        case "DIVIDE":
          var num = stackObject.params.val1 / stackObject.params.val2;
          break;
        case "POWER":
          var num = Math.pow(stackObject.params.val1, stackObject.params.val2);
          break;
        case "MOD":
          var num = stackObject.params.val1 % stackObject.params.val2;
          break;
      }
    }
    bd.evaluator.ctr.returnHandler(num,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["math_number"] = {
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    bd.evaluator.ctr.returnHandler(parseFloat(block.field.__text),block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["null_block"] = {
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    bd.evaluator.ctr.returnHandler("nullObject",block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["math_round"] = {
  paramsInfo  : [{name:"roundDirection",type:"field",fieldName:"OP"},
                 {name:"val",type:"value",valueName:"NUM"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var roundDirection = stackObject.params.roundDirection;
    var value = stackObject.params.val;
    if(stackObject.params.val == "nullObject"){
      //TODO: throw debug warning, empty socket returning 0
      bd.evaluator.ctr.returnHandler(0,block.returnsEntity);
      return;
    } else {
      switch(roundDirection){
        case "ROUNDDOWN":
          var num = Math.floor(value);
          break;
        case "ROUNDUP":
          var num = Math.ceil(value);
          break;
        case "ROUND":
          var num = Math.round(value);
          break;
        case "ABSOLUTE":
          var num = Math.abs(value);
          break;
        case "NEGATIVE":
          var num = -value;
          break;
        case "ROOT":
          if(value < 0){
            var num = "nullObject";
          } else {
            var num = Math.sqrt(value);
          }
          break;
      }
    }
    bd.evaluator.ctr.returnHandler(num,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["logic_negate"] = {
  paramsInfo  : [{name:"val",type:"value",valueName:"BOOL"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    bd.evaluator.ctr.returnHandler(!(stackObject.params.val),block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["text"] = {
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    if(block.field.__text != null){
      bd.evaluator.ctr.returnHandler(block.field.__text,block.returnsEntity);
    } else {
      bd.evaluator.ctr.returnHandler("",block.returnsEntity);
    }
  }
};

bd.evaluator.ctr.configs["text_join"] = {
  getParams   : function(block){
    var paramsInfoArray = [];
    for(var i=0; i < block.mutation._items;i++){
      paramsInfoArray.push({name:"ADD"+i,type:"value",valueName:"ADD"+i});
    }
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var text = "";
    for(var i=0; i < block.mutation._items;i++){
      var textToAdd = (stackObject.params["ADD" + i] == "nullObject" ? "" : stackObject.params["ADD" + i]);
      text = text + textToAdd;
    }
    bd.evaluator.ctr.returnHandler(text,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["get_input_text"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var entityId = entityIdArray[0];
    bd.evaluator.ctr.returnHandler(bd.model.entityLookup(entityId).text,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["direction"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var entityId = entityIdArray[0];
    var componentObject = bd.component.lookup(entityId);
    if(componentObject.model.shareMode == "local") {
      bd.evaluator.ctr.returnHandler(componentObject.getLocalDirection(),block.returnsEntity);
    } else {
      bd.evaluator.ctr.returnHandler(bd.model.entityLookup(entityId).direction,block.returnsEntity);
    }
  }
};

bd.evaluator.ctr.configs["get_gravity"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var entityId = entityIdArray[0];
    var componentObject = bd.component.lookup(entityId);
    bd.evaluator.ctr.returnHandler(bd.entityLookup[entityId].gravityY,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["xy_of_entity"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"xOrY",type:"field",fieldName:"XY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var entityId = entityIdArray[0];
    if(bd.util.containsPrefix(entityId,"pointer:")) {
      var pointerObject = bd.phaser.ctr.entityTextToPointerObject(entityId);
      var xOrY = stackObject.params.xOrY;
      var returnValue = "nullObject";
      if(pointerObject) {
        if(xOrY == "x") {
          returnValue = pointerObject.clientX;
        } else {
          returnValue = pointerObject.clientY;
        }
      }
      bd.evaluator.ctr.returnHandler(returnValue,block.returnsEntity);
      return;
    }
    var xOrY = stackObject.params.xOrY;
    var componentObject = bd.component.lookup(entityId);
    if(componentObject.model.shareMode == "local") {
      bd.evaluator.ctr.returnHandler(componentObject.getLocalXY(xOrY),block.returnsEntity);
    } else {
      bd.evaluator.ctr.returnHandler(bd.model.entityLookup(entityId)[xOrY],block.returnsEntity);
    }
  }
};

bd.evaluator.ctr.configs["xy_of_pointer"] = {
  paramsInfo  : [{name:"xOrY",type:"field",fieldName:"XY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var xOrY = stackObject.params.xOrY;
    var viewComponentObject = bd.component.lookup(bd.model.getCurrentViewId());
    var phaserGameObject = viewComponentObject.getPhaserGameObject();
    if(phaserGameObject.input.activePointer) {
      bd.evaluator.ctr.returnHandler(phaserGameObject.input.activePointer[xOrY],block.returnsEntity);
    } else {
      bd.evaluator.ctr.returnHandler(0,block.returnsEntity);
    }
  }
};

bd.evaluator.ctr.configs["physics_direction"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var entityId = entityIdArray[0];
    var componentObject = bd.component.lookup(entityId);
    bd.evaluator.ctr.returnHandler(componentObject.getMovingDirection(),block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["angle_from_to_entity"] = {
  paramsInfo  : [{name:"entityIdArray1",type:"entity",fieldName:"ENTITY1"},
                 {name:"entityIdArray2",type:"entity",fieldName:"ENTITY2"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray1 = stackObject.params.entityIdArray1;
    var entityId1 = entityIdArray1[0];
    var entityIdArray2 = stackObject.params.entityIdArray2;
    var entityId2 = entityIdArray2[0];
    var angle = bd.evaluator.ctr.entityIdTextToAngle(entityId1,entityId2);
    bd.evaluator.ctr.returnHandler(angle,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["distance_from_to_entity"] = {
  paramsInfo  : [{name:"entityIdArray1",type:"entity",fieldName:"ENTITY1"},
                 {name:"entityIdArray2",type:"entity",fieldName:"ENTITY2"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray1 = stackObject.params.entityIdArray1;
    var entityId1 = entityIdArray1[0];
    var entityIdArray2 = stackObject.params.entityIdArray2;
    var entityId2 = entityIdArray2[0];

    var componentObject1 = bd.component.lookup(entityId1);
    var componentObject2 = bd.component.lookup(entityId2);
    var dy = componentObject2.getXOrY('y') - componentObject1.getXOrY('y');
    var dx = componentObject2.getXOrY('x') - componentObject1.getXOrY('x');

    bd.evaluator.ctr.returnHandler(Math.sqrt(Math.pow(dy,2) + Math.pow(dx,2)),block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["distance_from_to_point"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"xValue",type:"value",valueName:"X"},
                 {name:"yValue",type:"value",valueName:"Y"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityId = stackObject.params.entityIdArray[0];
    var componentObject = bd.component.lookup(entityId);
    var xValue = stackObject.params.xValue;
    var yValue = stackObject.params.yValue;
    var dy = componentObject.getXOrY('y') - yValue;
    var dx = componentObject.getXOrY('x') - xValue;
    bd.evaluator.ctr.returnHandler(Math.sqrt(Math.pow(dy,2) + Math.pow(dx,2)),block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["xy_speed"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"xOrY",type:"field",fieldName:"XY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var xOrY = stackObject.params.xOrY;
    bd.evaluator.ctr.returnHandler(bd.component.lookup(entityIdArray[0]).localGetXYSpeed(xOrY),block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["get_speed"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    bd.evaluator.ctr.returnHandler(bd.component.lookup(entityIdArray[0]).localGetSpeed(),block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["grid_get_tile_object"] = {
  paramsInfo  : [{name:"gridIdArray",type:"entity",fieldName:"GRID"},
                 {name:"column",type:"value",valueName:"COL"},
                 {name:"row",type:"value",valueName:"ROW"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var grid = bd.component.lookup(stackObject.params.entityIdArray[0])
    var column = Math.floor(stackObject.params.column)-1;
    var row = Math.floor(stackObject.params.row)-1;
    bd.evaluator.ctr.returnHandler(grid.getTileByColumnRow(column,row).id,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["grid_get_dimension"] = {
  paramsInfo  : [{name:"gridIdArray",type:"entity",fieldName:"GRID"},
                 {name:"columnOrRow",type:"field",fieldName:"DIMENSION"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var grid = bd.component.lookup(stackObject.params.entityIdArray[0]);
    var columnOrRow = stackObject.params.columnOrRow;
    var dimension = {COLUMN:grid.model.numColumns,ROW:grid.model.numRows};
    bd.evaluator.ctr.returnHandler(dimension[columnOrRow],block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["grid_get_entity_location"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"columnOrRow",type:"field",fieldName:"DIMENSION"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var columnOrRow = stackObject.params.columnOrRow;
    var v = (bd.component.lookup(entityIdArray[0]).getCurrentColumnOrRow()[columnOrRow] === null) ? "nullObject":bd.component.lookup(entityIdArray[0]).getCurrentColumnOrRow()[columnOrRow] + 1;
    bd.evaluator.ctr.returnHandler(v,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["timer_value"] = {
  evalFunc    : function(block) {
    var d = new Date();
    var timeNow = d.getTime();
    var v = (timeNow - bd.evaluator.ctr.timerStart)/1000;
    bd.evaluator.ctr.returnHandler(v,block.returnsEntity);
  }
};

bd.evaluator.ctr.configs["device_orientation"] = {
  paramsInfo  : [{name:"angleOrMagnitude",type:"field",fieldName:"MODE"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var angleOrMagnitude = stackObject.params.angleOrMagnitude;
    if(angleOrMagnitude == "ANGLE") {
      if(bd.deviceMotion.ctr.orientationAngle == null) {
        bd.evaluator.ctr.returnHandler("nullObject",block.returnsEntity);
      } else {
        bd.evaluator.ctr.returnHandler(bd.deviceMotion.ctr.orientationAngle,block.returnsEntity);
      }
    } else if(angleOrMagnitude == "MAGNITUDE") {
      if(bd.deviceMotion.ctr.orientationMagnitude == null) {
        bd.evaluator.ctr.returnHandler("nullObject",block.returnsEntity);
      } else {
        bd.evaluator.ctr.returnHandler(bd.deviceMotion.ctr.orientationMagnitude,block.returnsEntity);
      }
    } else if(angleOrMagnitude == "X") {
      if(bd.deviceMotion.ctr.calculatedX == null) {
        bd.evaluator.ctr.returnHandler("nullObject",block.returnsEntity);
      } else {
        bd.evaluator.ctr.returnHandler(bd.deviceMotion.ctr.calculatedX,block.returnsEntity);
      }
    } else if (angleOrMagnitude == "Y") {
      if(bd.deviceMotion.ctr.calculatedY == null) {
        bd.evaluator.ctr.returnHandler("nullObject",block.returnsEntity);
      } else {
        bd.evaluator.ctr.returnHandler(bd.deviceMotion.ctr.calculatedY,block.returnsEntity);
      }
    } else {
      bd.evaluator.ctr.returnHandler(0,block.returnsEntity);
    }
  }
};


// ********************************************** //
// ********************************************** //
// *********** BLOCKS WITH NO OUTPUT ************ //
// ********************************************** //
// ********************************************** //

bd.evaluator.ctr.configs["forever_procedure"] = {
  evalFunc    : function(block){

    if(!bd.evaluator.ctr.breakLoop){
      var newCallStack = [];
      var stackObject = {block:block,context:bd.evaluator.ctr.context};
      newCallStack.push(stackObject);
      if(stackObject.block.statement && stackObject.block.statement.block){
        nextBlock = stackObject.block.statement.block;
      }
      var secondStackObject = {block:nextBlock,context:stackObject.context};
      newCallStack.push(secondStackObject)
      bd.evaluator.ctr.stacksToEvaluate.push(newCallStack);
    }
    bd.evaluator.ctr.breakLoop = false;
    bd.evaluator.ctr.callStack.pop();
    if(bd.evaluator.ctr.callStack.length != 0){
      //should never happen now, forever procedure should be on its own stack
      var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
      bd.evaluator.ctr.nextBlockInCallStack(stackObject.block.next);
    } else {
      bd.evaluator.ctr.continuePreviousStack();
    }
  }
};

bd.evaluator.ctr.configs["controls_flow_statements"] = {
  paramsInfo  : [{name:"titleText",type:"field",fieldName:"FLOW"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var titleText = stackObject.params.titleText;
    if(titleText =="BREAK"){
      bd.evaluator.ctr.breakLoop = true;
    }

    var cutoffIndex = null;
    for(var i=0;i<bd.evaluator.ctr.callStack.length;i++){
      var stackObj = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1-i];
      if(stackObj.block._type == "animation_def" ||
         stackObj.block._type == "controls_forEach" ||
         stackObj.block._type == "controls_for_range" ||
         stackObj.block._type == "controls_forEachTraits" ||
         stackObj.block._type == "forever_procedure" ||
         stackObj.block._type == "forever_loop"){

        cutoffIndex = bd.evaluator.ctr.callStack.length-1-i+1;//1 after the loop is the cutoff
        break;
      }
    }

    if(cutoffIndex != null){
      bd.evaluator.ctr.callStack.splice(cutoffIndex,bd.evaluator.ctr.callStack.length);
      bd.evaluator.ctr.evaluateStack();
    }
  }
};

bd.evaluator.ctr.configs["forever_loop"] = {
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    if(bd.evaluator.ctr.breakLoop){
      bd.evaluator.ctr.breakLoop = false;
      stackObject.loopContext = null;
      bd.evaluator.ctr.nextBlockInCallStack(stackObject.block.next);
      return;
    }

    var loopContext = stackObject.loopContext;
    if(loopContext == null){
      stackObject.loopContext = {};
      loopContext = stackObject.loopContext;
      var newCallObject = {block:stackObject.block.statement.block,context:stackObject.context,callingFunction:stackObject.callingFunction}
      bd.evaluator.ctr.addToCallStack(newCallObject,false);
      bd.evaluator.ctr.evaluateStack();
    } else {
      var nextBlock;
      if(stackObject.block.statement && stackObject.block.statement.block){
        nextBlock = stackObject.block.statement.block;
      }
      var secondStackObject = {block:nextBlock,context:stackObject.context};
      bd.evaluator.ctr.callStack.push(secondStackObject)
      bd.evaluator.ctr.stacksToEvaluate.push(bd.evaluator.ctr.callStack);
      bd.evaluator.ctr.callStack = [];
      bd.evaluator.ctr.continuePreviousStack();
    }
  }
};

bd.evaluator.ctr.configs["controls_forEachEntity"] = {
  paramsInfo  : [{name:"varTitle",type:"fieldVariable",fieldName:"VAR"},
                 {name:"entityTitle",type:"fieldVariable",fieldName:"ENTITY"},
                 {name:"entityIdArrayAnyOrAll",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var loopContext = stackObject.loopContext;
    if(loopContext == null){
      stackObject.loopContext = {};
      loopContext = stackObject.loopContext;

      loopContext["loopIndexNum"] =0;
      loopContext["loopList"] =[];

      //get entity title
      var entityTitle = stackObject.params.entityTitle;
      var entityIdArray = [];

      if(bd.util.containsPrefix(entityTitle.__text,"userDefinedContext")){
        //if getting user defined value
        var loopVariable = bd.util.removePrefix(entityTitle.__text,"userDefinedContext")
        entityIdArray = bd.evaluator.ctr.context[loopVariable];//bd.evaluator.ctr.entityTitleToEntityIdArray("ENTITY",block)[0];
      } else if(bd.util.containsPrefix(entityTitle.__text,"id")){
        //get all pieces
        var entityId = bd.util.removePrefix(entityTitle.__text,"id")
        entityIdArray = bd.entityLookup[entityId].instanceIds;
        //player sockets...****INCOMPLETE HACK, SHOULD USE SOMETHING LIKE bd.evaluator.ctr.entityTitleToEntityIdArray
        if(block.mutation._entity_entity_player){
          if(bd.util.containsPrefix(block.mutation._entity_entity_player,"id")){
            var playerId = bd.util.removeIdPrefix(block.mutation._entity_entity_player);
            var playerIds = [playerId];
            var entityPlayerInstanceIds = [];
            for(var i=0;i<entityIdArray.length;i++){
              var possibleEntityPlayerId = bd.evaluator.ctr.getEntityPlayerInstanceIds(playerIds,entityIdArray[i])[0]
              if(possibleEntityPlayerId){
                entityPlayerInstanceIds.push(possibleEntityPlayerId);
              }
            }
            entityIdArray = entityPlayerInstanceIds;
          }
        } else if(bd.model.entityLookup(entityId).shareMode == "local") {
          var localPlayerEntityIds = [];
          for(var i=0;i<entityIdArray.length;i++) {
            if(bd.model.entityLookup(entityIdArray[i]).playerId == bd.player.ctr.playerId) {
              localPlayerEntityIds.push(entityIdArray[i]);
            }
          }
          entityIdArray = localPlayerEntityIds;
        }

      } else {
        //any or all
        entityIdArray = stackObject.params.entityIdArrayAnyOrAll;
      }

      loopContext["loopList"] = entityIdArray;

    } else {
      loopContext["loopIndexNum"] = loopContext["loopIndexNum"] + 1;
    }

    if(loopContext["loopIndexNum"] < loopContext["loopList"].length && !bd.evaluator.ctr.breakLoop){
      var varTitle = stackObject.params.varTitle;
      stackObject.context[varTitle.__text] = loopContext["loopList"][loopContext["loopIndexNum"]];
      var newCallObject = {block:stackObject.block.statement.block,context:stackObject.context,callingFunction:stackObject.callingFunction}
      bd.evaluator.ctr.addToCallStack(newCallObject,false);
      bd.evaluator.ctr.evaluateStack();
    } else {
      bd.evaluator.ctr.breakLoop = false;
      stackObject.loopContext = null;
      bd.evaluator.ctr.nextBlockInCallStack(stackObject.block.next);
    }
  }
};

bd.evaluator.ctr.configs["controls_forEachTraits"] = {
  paramsInfo  : [{name:"varTitle",type:"fieldVariable",fieldName:"VAR"},
                 {name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"traitDefIdArray",type:"entity",fieldName:"TRAIT"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var loopContext = stackObject.loopContext;
    if(loopContext == null){
      stackObject.loopContext = {};
      loopContext = stackObject.loopContext;

      loopContext["loopIndexNum"] =0;
      loopContext["loopList"] =[];

      var entityId = stackObject.params.entityIdArray[0];
      var traitDefId = stackObject.params.traitDefIdArray[0];

      var entityTraitIds = bd.entityLookup[entityId].traitIds;
      for(var i=0;i<entityTraitIds.length;i++){
        if(bd.entityLookup[entityTraitIds[i]].traitDefId == traitDefId){
          loopContext["loopList"] = bd.entityLookup[entityTraitIds[i]].value;
          break;
        }
      }

    } else {
      loopContext["loopIndexNum"] = loopContext["loopIndexNum"] + 1;
    }

    if(loopContext["loopIndexNum"] < loopContext["loopList"].length && !bd.evaluator.ctr.breakLoop){
      var varTitle = stackObject.params.varTitle;
      stackObject.context[varTitle.__text] = loopContext["loopList"][loopContext["loopIndexNum"]];
      var newCallObject = {block:stackObject.block.statement.block,context:stackObject.context,callingFunction:stackObject.callingFunction}
      bd.evaluator.ctr.addToCallStack(newCallObject,false);
      bd.evaluator.ctr.evaluateStack();
    } else {
      bd.evaluator.ctr.breakLoop = false;
      stackObject.loopContext = null;
      bd.evaluator.ctr.nextBlockInCallStack(stackObject.block.next);
    }
  }
};

// NOT USED
bd.evaluator.ctr.configs["controls_forEachList"] = {
  paramsInfo  : [{name:"loopList",type:"value",valueName:"LIST"},
                 {name:"varTitle",type:"fieldVariable",fieldName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var loopContext = stackObject.loopContext;
    if(loopContext == null){
      stackObject.loopContext = {};
      loopContext = stackObject.loopContext;

      loopContext["loopIndexNum"] =0;
      loopContext["loopList"] = stackObject.params.loopList;

    } else {
      loopContext["loopIndexNum"] = loopContext["loopIndexNum"] + 1;
    }

    if(loopContext["loopIndexNum"] < loopContext["loopList"].length && !bd.evaluator.ctr.breakLoop){
      var varTitle = stackObject.params.varTitle;
      stackObject.context[varTitle.__text] = loopContext["loopList"][loopContext["loopIndexNum"]];
      var newCallObject = {block:stackObject.block.statement.block,context:stackObject.context,callingFunction:stackObject.callingFunction}
      bd.evaluator.ctr.addToCallStack(newCallObject,false);
      bd.evaluator.ctr.evaluateStack();
    } else {
      bd.evaluator.ctr.breakLoop = false;
      stackObject.loopContext = null;
      bd.evaluator.ctr.nextBlockInCallStack(stackObject.block.next);
    }
  }
};

bd.evaluator.ctr.configs["controls_for_each_list"] = {
  // jumphere
  paramsInfo  : [{name:"loopList",type:"value",valueName:"LIST"},
                 {name:"varTitle",type:"variableName",valueName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var loopContext = stackObject.loopContext;
    if(loopContext == null){
      stackObject.loopContext = {};
      loopContext = stackObject.loopContext;

      loopContext["loopIndexNum"] = 0;
      loopContext["loopList"] = stackObject.params.loopList;

    } else {
      loopContext["loopIndexNum"] = loopContext["loopIndexNum"] + 1;
    }

    if(loopContext["loopIndexNum"] < loopContext["loopList"].length && !bd.evaluator.ctr.breakLoop){
      var varTitle = stackObject.params.varTitle;
      stackObject.context[varTitle.__text] = {type:"value",value:loopContext["loopList"][loopContext["loopIndexNum"]]};
      var newCallObject = {block:stackObject.block.statement.block,context:stackObject.context,callingFunction:stackObject.callingFunction}
      bd.evaluator.ctr.addToCallStack(newCallObject,false);
      bd.evaluator.ctr.evaluateStack();
    } else {
      bd.evaluator.ctr.breakLoop = false;
      stackObject.loopContext = null;
      bd.evaluator.ctr.nextBlockInCallStack(stackObject.block.next);
    }
  }
};

bd.evaluator.ctr.configs["controls_for_range"] = {
  paramsInfo  : [{name:"startNumber",type:"value",valueName:"FROM"},
                 {name:"endNumber",type:"value",valueName:"TO"},
                 {name:"step",type:"value",valueName:"STEP"},
                 {name:"varTitle",type:"fieldVariable",fieldName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var loopContext = stackObject.loopContext;
    if(loopContext == null){
      stackObject.loopContext = {};
      loopContext = stackObject.loopContext;

      var startNumber = stackObject.params.startNumber;
      var endNumber = stackObject.params.endNumber;
      var step = stackObject.params.step;

      if((endNumber < startNumber && step > 0) ||
         (endNumber > startNumber && step < 0)){
        endNumber = startNumber;
      }
      loopContext["startNumber"] =startNumber;
      loopContext["endNumber"] =endNumber;
      loopContext["step"] =step;
      loopContext["currentNum"] = loopContext["startNumber"];


    } else {
      loopContext["currentNum"] = loopContext["currentNum"] + loopContext["step"];
    }

    //need to handle invalid input / end of loop
    if( (loopContext["currentNum"] > loopContext["endNumber"] && loopContext["step"] > 0) ||
        (loopContext["currentNum"] < loopContext["endNumber"] && loopContext["step"] < 0) ||
        (loopContext["step"] == 0) ||
        bd.evaluator.ctr.breakLoop){

      bd.evaluator.ctr.breakLoop = false;
      stackObject.loopContext = null;
      bd.evaluator.ctr.nextBlockInCallStack(stackObject.block.next);

    } else {

      var varTitle = stackObject.params.varTitle;
      stackObject.context[varTitle.__text] = {type:"value",value:loopContext["currentNum"]};//loopContext["loopList"][loopContext["loopIndexNum"]];
      var newCallObject = {block:stackObject.block.statement.block,context:stackObject.context,callingFunction:stackObject.callingFunction}
      bd.evaluator.ctr.addToCallStack(newCallObject,false);
      bd.evaluator.ctr.evaluateStack();
    }
  }
};

bd.evaluator.ctr.configs["controls_for_count"] = {
  paramsInfo  : [{name:"startNumber",type:"value",valueName:"FROM"},
                 {name:"endNumber",type:"value",valueName:"TO"},
                 {name:"step",type:"value",valueName:"STEP"},
                 {name:"varTitle",type:"variableName",valueName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var loopContext = stackObject.loopContext;
    if(loopContext == null){
      stackObject.loopContext = {};
      loopContext = stackObject.loopContext;

      var startNumber = stackObject.params.startNumber;
      var endNumber = stackObject.params.endNumber;
      var step = stackObject.params.step;

      if((endNumber < startNumber && step > 0) ||
         (endNumber > startNumber && step < 0)){
        endNumber = startNumber;
      }
      loopContext["startNumber"] =startNumber;
      loopContext["endNumber"] =endNumber;
      loopContext["step"] =step;
      loopContext["currentNum"] = loopContext["startNumber"];


    } else {
      loopContext["currentNum"] = loopContext["currentNum"] + loopContext["step"];
    }

    //need to handle invalid input / end of loop
    if( (loopContext["currentNum"] > loopContext["endNumber"] && loopContext["step"] > 0) ||
        (loopContext["currentNum"] < loopContext["endNumber"] && loopContext["step"] < 0) ||
        (loopContext["step"] == 0) ||
        bd.evaluator.ctr.breakLoop){

      bd.evaluator.ctr.breakLoop = false;
      stackObject.loopContext = null;
      bd.evaluator.ctr.nextBlockInCallStack(stackObject.block.next);

    } else {

      var varTitle = stackObject.params.varTitle;
      stackObject.context[varTitle.__text] = {type:"value",value:loopContext["currentNum"]};//loopContext["loopList"][loopContext["loopIndexNum"]];
      var newCallObject = {block:stackObject.block.statement.block,context:stackObject.context,callingFunction:stackObject.callingFunction}
      bd.evaluator.ctr.addToCallStack(newCallObject,false);
      bd.evaluator.ctr.evaluateStack();
    }
  }
};

bd.evaluator.ctr.configs["variables_init_global_type"] = {
  paramsInfo  : [{name:"variableName",type:"field",fieldName:"VAR"},
                 {name:"val",type:"value",valueName:"VALUE"},
                 {name:"typeString",type:"field",fieldName:"TYPE"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var variableName = stackObject.params.variableName;
    var typeString = stackObject.params.typeString;
    var value = stackObject.params.val;
    var isValue = (typeString == "type:value");
    bd.component.lookup(bd.model.getGameInfo().id).setGlobalVariable(variableName,value,isValue);

    bd.evaluator.ctr.callStack = [];
    bd.evaluator.ctr.continuePreviousStack();
  }
};

bd.evaluator.ctr.configs["variables_init"] = {
  //jumphere
  paramsInfo  : [{name:"variableName",type:"variableName",valueName:"VAR"},
                 {name:"val",type:"value",valueName:"VALUE"},
                 {name:"typeString",type:"field",fieldName:"TYPE"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var variableName = stackObject.params.variableName;
    var typeString = stackObject.params.typeString;
    var value = stackObject.params.val;
    var isValue = (typeString == "type:value");
    bd.component.lookup(bd.model.getGameInfo().id).setGlobalVariable(variableName.__text,value,isValue);

    bd.evaluator.ctr.callStack = [];
    bd.evaluator.ctr.continuePreviousStack();
  }
};

//TODO: FIX HOW THIS ONE UPDATES CONTEXT TO USE NEW DESIGN!
bd.evaluator.ctr.configs["variables_local"] = {
  paramsInfo  : [{name:"variableName",type:"field",fieldName:"VAR"},
                 {name:"val",type:"value",valueName:"VALUE"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var variableContext = stackObject.variableContext;
    if(variableContext == null){
      stackObject.variableContext = {};
      variableContext = stackObject.variableContext;
      for (var x = 0; x < parseInt(stackObject.block.mutation._vars); x++) {
        stackObject.context[bd.evaluator.ctr.getTitleTextFromBlock('TEXT' + x, block)] = {type:"value",value:bd.evaluator.ctr.evalValue(bd.evaluator.ctr.getValueFromBlock('DECL' + x,block))};
      }
      var newCallObject = {block:stackObject.block.statement.block,context:stackObject.context,callingFunction:stackObject.callingFunction}
        bd.evaluator.ctr.addToCallStack(newCallObject,false);
        bd.evaluator.ctr.evaluateStack();
    } else {
      bd.evaluator.ctr.nextBlockInCallStack(block.next);
    }
  }
};

bd.evaluator.ctr.configs["variables_set"] = {
  paramsInfo  : [{name:"variableName",type:"field",fieldName:"VAR"},
                 {name:"val",type:"value",valueName:"VALUE"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var variableName = stackObject.params.variableName;
    var value = stackObject.params.val;

    if(stackObject.context[variableName]) {
      if(stackObject.context[variableName].type && stackObject.context[variableName].type == "value") {
        stackObject.context[variableName].value = value;
      } else {
        stackObject.context[variableName] = value;
      }
    } else {
      var gameInfoComponent = bd.component.lookup(bd.model.getGameInfo().id);
      var globalVariableValue = gameInfoComponent.getGlobalVariable(variableName);
      if(globalVariableValue != null) {
        gameInfoComponent.setGlobalVariable(variableName,value,(globalVariableValue.type == "value"));
      }
    }
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["variables_change_by"] = {
  paramsInfo  : [{name:"variableName",type:"field",fieldName:"VAR"},
                 {name:"val",type:"value",valueName:"VALUE"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var variableName = stackObject.params.variableName;
    var value = stackObject.params.val;

    if(stackObject.context[variableName]) {
      if(stackObject.context[variableName].type && stackObject.context[variableName].type == "value") {
        stackObject.context[variableName].value += value;
      }
    } else {
      var gameInfoComponent = bd.component.lookup(bd.model.getGameInfo().id);
      var globalVariableValue = gameInfoComponent.getGlobalVariable(variableName);
      if(globalVariableValue != null) {
        var oldValue = gameInfoComponent.getGlobalVariable(variableName).value
        gameInfoComponent.setGlobalVariable(variableName,oldValue + value,(globalVariableValue.type == "value"));
      }

    }
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["EVENT_BLOCK"] = {
  evalFunc    : function(block){
    bd.evaluator.ctr.callStack = [];
    bd.evaluator.ctr.continuePreviousStack();
  }
};

bd.evaluator.ctr.configs["game_start"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["key_pressed"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["custom_key_pressed"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["piece_clicked"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["piece_dropped"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["piece_dropped_on_target"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["when_collide"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["entity_clicked"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["when_phaser_piece_dropped"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["grid_event_entity_dropped"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["grid_event_entity_removed"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["when_phaser_physics_collide"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["when_collide_edge"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["when_input_event"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];
bd.evaluator.ctr.configs["receive_message"] = bd.evaluator.ctr.configs["EVENT_BLOCK"];

bd.evaluator.ctr.configs["stop_sound"] = {
  paramsInfo  : [{name:"costumeIdArray",type:"entity",fieldName:"VAR2"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var costumeId = stackObject.params.costumeIdArray[0];
    var soundObject = bd.component.lookup(bd.model.entityLookup(costumeId).assetId).getSoundObject()
    if(soundObject) {
      soundObject.stop();
    }
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["play_sound"] = {
  paramsInfo  : [{name:"costumeIdArray",type:"entity",fieldName:"VAR2"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var costumeId = stackObject.params.costumeIdArray[0];
    var fx;
    var viewComponentObject = bd.component.lookup(bd.model.getCurrentViewId());
    var game = viewComponentObject.getPhaserGameObject();
    var assetId = bd.model.entityLookup(costumeId).assetId;
    var oldSound = bd.component.lookup(assetId).getSoundObject();

    if(!oldSound || !oldSound.isPlaying) {
      fx = game.add.audio('assetId:'+assetId);
      bd.component.lookup(assetId).setSoundObject(fx);
      bd.component.lookup(assetId).getSoundObject().play();
    }
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_can_move"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"},
                 {name:"val",type:"value",valueName:"x"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var value = stackObject.params.val;

    bd.model.addModelUpdateElement(entityIdArray,"set","movable",value,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_pass_through"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"},
                 {name:"val",type:"value",valueName:"x"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var value = stackObject.params.val;

    bd.model.addModelUpdateElement(entityIdArray,"set","passthrough",value,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["reset_timer"] = {
  evalFunc    : function(block) {
    var d = new Date();
    bd.evaluator.ctr.timerStart = d.getTime()
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

//only works for phaser pieces
bd.evaluator.ctr.configs["remove_from_game"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var componentObject;
    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var propagatedEntityIds = localAndPropagatedEntityIds.propagatedEntityIds;
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;
    for(var i=0;i<localEntityIds.length;i++) {
      componentObject = bd.component.lookup(localEntityIds[i]);
      if(componentObject.getDisplayObject() != null) {
        //only works for phaser pieces
        componentObject.getDisplayObject().kill();
        componentObject.setDisplayObject(null);
        //true make the checks be ignored...
        //need to have warnings if something important deleted
        componentObject.deleteInstance(true)
      }
    }
    bd.model.addModelUpdateElement(propagatedEntityIds,"command","deleteInstance",null,{updateUIForOrigin:true,updateModelForOrigin:false,updateModelInEditor:false,updateUIInEditor:false})
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["phaser_set_speed"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"speed",type:"value",valueName:"SPEED"},
                 {name:"pointingOrMoving",type:"field",fieldName:"POINTING_OR_MOVING"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var speed = stackObject.params.speed;
    var pointingOrMoving = stackObject.params.pointingOrMoving;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localSetSpeed("set",speed,pointingOrMoving);
    }
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["phaser_change_speed"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"speed",type:"value",valueName:"SPEED"},
                 {name:"pointingOrMoving",type:"field",fieldName:"POINTING_OR_MOVING"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var speed = stackObject.params.speed;
    var pointingOrMoving = stackObject.params.pointingOrMoving;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localSetSpeed("change",speed,pointingOrMoving);
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["phaser_set_speed_at_angle"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"speed",type:"value",valueName:"SPEED"},
                 {name:"angle",type:"value",valueName:"ANGLE"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var speed = stackObject.params.speed;
    var angle = stackObject.params.angle;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localSetSpeedAtAngle("set",speed,angle);
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["phaser_change_speed_at_angle"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"speed",type:"value",valueName:"SPEED"},
                 {name:"angle",type:"value",valueName:"ANGLE"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var speed = stackObject.params.speed;
    var angle = stackObject.params.angle;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localSetSpeedAtAngle("change",speed,angle);
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["phaser_set_angular_velocity"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"velocity",type:"value",valueName:"VELOCITY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var velocity = stackObject.params.velocity;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localSetAngularVelocity(velocity);
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["phaser_change_angular_velocity"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"velocity",type:"value",valueName:"VELOCITY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var velocity = stackObject.params.velocity;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localChangeAngularVelocity(velocity);
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["clone_to_xy"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"viewIdArray",type:"entity",fieldName:"VIEW"},
                 {name:"xValue",type:"value",valueName:"X"},
                 {name:"yValue",type:"value",valueName:"Y"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var cloneIds = [];
    var isEntityClass = false;
    var entityId = stackObject.params.entityIdArray[0];
    var entityFromPrefix = bd.model.entityLookup(entityId);

    //check if is class or instance
    if(bd.model.entityParentNameToChildName[entityFromPrefix.type] != null){
      isEntityClass = true;
      var entityClass = entityFromPrefix;
      var childTypeName = bd.model.entityParentNameToChildName[entityClass.type];
      var childConstructor = bd.component.typeNameToComponent[childTypeName].constructor;

      if(entityClass.shareMode == "perPlayer"){
      //get player ids
        var playerIdArray = bd.evaluator.ctr.entityTitleToEntityIdArray("ENTITY_PLAYER",block);
        for(var i=0;i<playerIdArray.length;i++){
          var newEntity = new childConstructor(null,entityId,null,playerIdArray[i],playerIdArray[i]);
          //bd.model.addEntityToLookup(newEntity.id,newEntity);
          cloneIds.push(newEntity.id);
        }
      } else if(entityClass.shareMode == "local"){
        var newEntity = new childConstructor(null,entityId,null,bd.player.ctr.playerId,bd.player.ctr.playerId);
        cloneIds.push(newEntity.id);

      } else if(entityClass.shareMode == "share"){
        var newEntity = new childConstructor(null,entityId,null,null,null);
        //bd.model.addEntityToLookup(newEntity.id,newEntity);
        cloneIds.push(newEntity.id);
      }
    }

    //is instance
    if(!isEntityClass){
      //get id (using normal method)
      var entityIds = stackObject.params.entityIdArray;
      for(var i=0;i<entityIds.length;i++){
        var entityId = entityIds[i];
        var entity = bd.model.entityLookup(entityId);
        var entityConstructor = bd.component.typeNameToComponent[entity.type].constructor;
        if(entity.shareMode == "perPlayer" || entity.shareMode == "local"){
          //create instance per player
          var newEntity = new entityConstructor(null,entity.parentId,entity,entity.playerId,entity.visibleToPlayerId);
          cloneIds.push(newEntity.id);
        } else {
          //create instance
          var newEntity = new entityConstructor(null,entity.parentId,entity,null,null);
          cloneIds.push(newEntity.id);
        }

      }

    }


    var oldViewId = newEntity.model.viewId
    //for each clone set x,y
    var viewId = stackObject.params.viewIdArray[0];

    //TODO should get layer from block, instead we'll cheat for now and get the top entity layer
    var layerIds = bd.component.lookup(viewId).getLayerIds();
    var layerId = null;
    for(var i=layerIds.length-1;i>=0;i--) {
      //TODO, don't assume it's an entity layer
      if(bd.component.lookup(layerIds[i]).type == "tmxEntityLayer") {
        layerId = layerIds[i];
        break;
      }
    }

    var xValue = stackObject.params.xValue;
    var yValue = stackObject.params.yValue;
    if(oldViewId != viewId) {
      bd.model.addModelUpdateElement(cloneIds,"set","viewId",viewId,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    }
    bd.model.addModelUpdateElement(cloneIds,"set","layerId",layerId,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.addModelUpdateElement(cloneIds,"set","x",xValue,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.addModelUpdateElement(cloneIds,"set","y",yValue,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});

    for(var i=0;i<cloneIds.length;i++){
      var entityArrayName = bd.model.entityLookup(cloneIds[i]).type + "Ids";
      var shouldPropagate = true;
      if(bd.model.entityLookup(cloneIds[i]).shareMode == "local") {
        shouldPropagate = false;
      }
      bd.model.addModelUpdateElement([layerId],"push","entityIds",cloneIds[i],{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:true,updateUIInEditor:false,shouldPropagate:shouldPropagate});
      if(oldViewId != viewId) {
        if(oldViewId != null) {
          bd.model.addModelUpdateElement([oldViewId],"removeValue",entityArrayName,cloneIds[i],{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:true,updateUIInEditor:false,shouldPropagate:shouldPropagate});
        }
        bd.model.addModelUpdateElement([viewId],"push",entityArrayName,cloneIds[i],{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:true,updateUIInEditor:false,shouldPropagate:shouldPropagate});
      }

    }
    bd.model.sendUpdates();
    bd.model.addTraitsToEntities(cloneIds);

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["wait"] = {
  paramsInfo  : [{name:"waitTime",type:"value",valueName:"SECONDS"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var waitTime = stackObject.params.waitTime;
    var timeInMilliseconds = waitTime * 1000;
    var callStackJSONString = JSON.stringify(bd.evaluator.ctr.callStack);
    (function() {
      var t=setTimeout(
        function(stringifiedPreviousState){
          delete bd.evaluator.ctr.activeTimerIds[t];
          var previousState = JSON.parse(stringifiedPreviousState);

          bd.evaluator.ctr.callStack= previousState.callStack;
          bd.evaluator.ctr.context = previousState.context;
          var block = previousState.block;
          bd.evaluator.ctr.nextBlockInCallStack(block.next);
        },
        timeInMilliseconds,
        JSON.stringify({callStack:bd.evaluator.ctr.callStack, block:block,context:bd.evaluator.ctr.context})
      );
      bd.evaluator.ctr.activeTimerIds[t] = true;
    })();
    bd.evaluator.ctr.continuePreviousStack();
  }
};

bd.evaluator.ctr.configs["set_drag"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"draggable",type:"value",valueName:"DRAG"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var draggable = stackObject.params.draggable;
    bd.model.addModelUpdateElement(entityIdArray,"set","draggable",draggable,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["stop_physics_piece"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    bd.model.addModelUpdateElement(entityIdArray,"set","speed",0,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false,shouldPropagate:false});
    bd.model.addModelUpdateElement(entityIdArray,"set","active",false,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false,shouldPropagate:false});
    //bd.model.addModelUpdateElement([entityId],"command","stopPhysicsPiece",null,{updateUIForOrigin:true,updateModelForOrigin:false,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["activate_physics_piece"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    bd.model.addModelUpdateElement(entityIdArray,"set","active",true,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false,shouldPropagate:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_gravity"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"gravity",type:"value",valueName:"GRAVITY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var gravity = stackObject.params.gravity;
    bd.model.addModelUpdateElement(entityIdArray,"set","gravityY",gravity,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false,shouldPropagate:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_speed"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"speed",type:"value",valueName:"SPEED"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityId = stackObject.params.entityIdArray[0];
    var speed = stackObject.params.speed;

    bd.model.addModelUpdateElement([entityId],"set","speed",speed,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false,shouldPropagate:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_velocity"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"speed",type:"value",valueName:"SPEED"},
                 {name:"direction",type:"value",valueName:"DIRECTION"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityId = stackObject.params.entityIdArray[0];
    var speed = stackObject.params.speed;
    var direction = stackObject.params.direction;

    bd.model.addModelUpdateElement([entityId],"set","speed",speed,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false,shouldPropagate:false});
    bd.model.addModelUpdateElement([entityId],"set","direction",direction,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false,shouldPropagate:false});
    bd.model.addModelUpdateElement([entityId],"command","setVelocity",{speed:speed,direction:direction},{updateUIForOrigin:true,updateModelForOrigin:false,updateModelInEditor:false,updateUIInEditor:false,shouldPropagate:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["melon_set_velocity"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"velocity",type:"value",valueName:"VELOCITY"},
                 {name:"xOrY",type:"field",fieldName:"XY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var xOrY = stackObject.params.xOrY;
    var velocity = stackObject.params.velocity;

    //for backward compatibility with melon
    //in place for demos only (4/25)
    //will remove when melon is removed from use
    if(bd.component.lookup(bd.model.getCurrentViewId()).type == "melonView") {
      bd.model.addModelUpdateElement(entityIdArray,"command","setVelocity",{xOrY:xOrY,velocity:velocity},{updateUIForOrigin:true,updateModelForOrigin:false,updateModelInEditor:false,updateUIInEditor:false,shouldPropagate:false});
      bd.model.sendUpdates();
    } else {
      var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
      var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

      for(var i=0;i<localEntityIds.length;i++) {
        bd.component.lookup(localEntityIds[i]).localSetXYSpeed(xOrY,velocity);
      }
    }
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["apply_impulse"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"direction",type:"value",valueName:"DIRECTION"},
                 {name:"power",type:"value",valueName:"POWER"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityId = stackObject.params.entityIdArray[0];
    var power = stackObject.params.power;
    var direction = stackObject.params.direction;

    bd.model.addModelUpdateElement([entityId],"command","applyImpulse",{power:power,direction:direction},{updateUIForOrigin:true,updateModelForOrigin:false,updateModelInEditor:false,updateUIInEditor:false,shouldPropagate:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["change_x"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"xOrY",type:"field",fieldName:"XY"},
                 {name:"val",type:"value",valueName:"VALUE"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var xOrY = stackObject.params.xOrY;
    var value = stackObject.params.val;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var propagatedEntityIds = localAndPropagatedEntityIds.propagatedEntityIds;
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;
    bd.model.addModelUpdateElement(propagatedEntityIds,"change",xOrY,value,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localChangeXY(xOrY,value);
    }
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["grid_move_by_col_row"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"direction",type:"field",fieldName:"DIRECTION"},
                 {name:"absValue",type:"value",valueName:"NUM"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var direction = stackObject.params.direction;
    var absValue = stackObject.params.absValue;
    var xOrY = {left:'x',right:'x',up:'y',down:'y'}
    for (var i=0;i<entityIdArray.length;i++){
      var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
      var propagatedEntityIds = localAndPropagatedEntityIds.propagatedEntityIds;
      var localEntityIds = localAndPropagatedEntityIds.localEntityIds;
      var moveEntities = function(entityList) {
        for (var k=0;k<entityList.length;k++) {
          var grid = bd.component.lookup(entityList[k]).getCurrentGrid()
          if (grid != null) {
            var sprite = bd.component.lookup(entityList[k])
            var currentColumn = sprite.getCurrentColumnOrRow()['COLUMN']
            var currentRow = sprite.getCurrentColumnOrRow()['ROW']
            if (direction === 'left' && absValue > currentColumn) {
              absValue = currentColumn
            } else if (direction === 'right' && absValue >  grid.numColumns - currentColumn - 1) {
              absValue = grid.numColumns - currentColumn - 1
            } else if (direction === 'up' && absValue > currentRow) {
              absValue = currentRow
            } else if (direction === 'down' && absValue > grid.numRows - currentRow - 1) {
              absValue = grid.numRows - currentRow - 1
            }
            var h = (grid.horizontalMargin === 0) ? 1 : 2
            var v = (grid.verticalMargin === 0) ? 1 : 2
            var horizontalSpace = absValue*(grid.tileWidth+grid.horizontalMargin+h*grid.borderThickness)
            var verticalSpace = absValue*(grid.tileHeight+grid.verticalMargin+v*grid.borderThickness)
            var value = {left:-horizontalSpace,right:horizontalSpace,up:-verticalSpace,down:verticalSpace}
            if (entityList === propagatedEntityIds) {
              bd.model.addModelUpdateElement([entityList[k]],"change",xOrY[direction],value[direction],{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
              bd.model.sendUpdates();
            } else if (entityList === localEntityIds) {
              bd.component.lookup(entityList[k]).localChangeXY(xOrY[direction],value[direction])
            }
          }
        }
      }
      moveEntities(propagatedEntityIds);
      moveEntities(localEntityIds);
    }
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["grid_move_to_col_row"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"column",type:"value",valueName:"COL"},
                 {name:"row",type:"value",valueName:"ROW"},
                 {name:"gridIdArray",type:"entity",fieldName:"GRID"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var column = Math.floor(stackObject.params.column)-1;
    var row = Math.floor(stackObject.params.row)-1;
    var grid = bd.component.lookup(stackObject.params.gridIdArray[0]);
    if (column >= grid.model.numColumns) {
      column = grid.model.numColumns - 1
    } else if (column < 0) {
      column = 0
    }
    if (row >= grid.model.numRows) {
      row = grid.model.numRows - 1
    } else if (row < 0) {
      row = 0
    }
    var gridLocation = grid.xOrYByColumnRow(column,row)
    var xValue = gridLocation['X']
    var yValue = gridLocation['Y']

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var propagatedEntityIds = localAndPropagatedEntityIds.propagatedEntityIds;
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    bd.model.addModelUpdateElement(propagatedEntityIds,"set","x",xValue,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.addModelUpdateElement(propagatedEntityIds,"set","y",yValue,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();

    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localMoveToXY(xValue,yValue);
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["move_to_x_y"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"xValue",type:"value",valueName:"X"},
                 {name:"yValue",type:"value",valueName:"Y"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var xValue = stackObject.params.xValue;
    var yValue = stackObject.params.yValue;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var propagatedEntityIds = localAndPropagatedEntityIds.propagatedEntityIds;
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    bd.model.addModelUpdateElement(propagatedEntityIds,"set","x",xValue,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.addModelUpdateElement(propagatedEntityIds,"set","y",yValue,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();

    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localMoveToXY(xValue,yValue);
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["move_steps"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"steps",type:"value",valueName:"STEPS"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var steps = stackObject.params.steps;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var propagatedEntityIds = localAndPropagatedEntityIds.propagatedEntityIds;
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    var componentObject;
    for(var i=0;i<propagatedEntityIds.length;i++) {
      componentObject = bd.component.lookup(propagatedEntityIds[i]);
      var xValue = componentObject.getXOrY('x') + (steps * Math.cos((Math.PI/180) * componentObject.getDirection()));
      var yValue = componentObject.getXOrY('y') + (steps * Math.sin((Math.PI/180) * componentObject.getDirection()));
      bd.model.addModelUpdateElement([propagatedEntityIds[i]],"set","x",xValue,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
      bd.model.addModelUpdateElement([propagatedEntityIds[i]],"set","y",yValue,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    }

    bd.model.sendUpdates();

    for(var i=0;i<localEntityIds.length;i++) {
      componentObject = bd.component.lookup(localEntityIds[i]);
      var xValue = componentObject.getXOrY('x') + (steps * Math.cos((Math.PI/180) * componentObject.getDirection()));
      var yValue = componentObject.getXOrY('y') + (steps * Math.sin((Math.PI/180) * componentObject.getDirection()));
      bd.component.lookup(localEntityIds[i]).localMoveToXY(xValue,yValue);
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_x"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"val",type:"value",valueName:"VALUE"},
                 {name:"xOrY",type:"field",fieldName:"XY"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var value = stackObject.params.val;
    var xOrY = stackObject.params.xOrY;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var propagatedEntityIds = localAndPropagatedEntityIds.propagatedEntityIds;
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    bd.model.addModelUpdateElement(propagatedEntityIds,"set",xOrY,value,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localSetXY(xOrY,value);
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["point_toward_entity"] = {
  paramsInfo  : [{name:"entityIdArray1",type:"entity",fieldName:"ENTITY1"},
                 {name:"entityIdArray2",type:"entity",fieldName:"ENTITY2"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray1 = stackObject.params.entityIdArray1;
    var entityId2 = stackObject.params.entityIdArray2[0];

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray1);
    var propagatedEntityIds = localAndPropagatedEntityIds.propagatedEntityIds;
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    for(var i=0;i<propagatedEntityIds.length;i++) {
      var direction = bd.evaluator.ctr.entityIdTextToAngle(propagatedEntityIds[i],entityId2);
      bd.model.addModelUpdateElement([propagatedEntityIds[i]],"set","direction",direction,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});

    }
    bd.model.sendUpdates();

    for(var i=0;i<localEntityIds.length;i++) {
      var direction = bd.evaluator.ctr.entityIdTextToAngle(localEntityIds[i],entityId2);
      bd.component.lookup(localEntityIds[i]).localDirection(direction,"set");
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["change_direction"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"direction",type:"value",valueName:"DIRECTION"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var direction = stackObject.params.direction;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var propagatedEntityIds = localAndPropagatedEntityIds.propagatedEntityIds;
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    bd.model.addModelUpdateElement(propagatedEntityIds,"change","direction",direction,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();

    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localDirection(direction,"change");
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["point_in_direction"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"direction",type:"value",valueName:"DIRECTION"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var direction = stackObject.params.direction;

    var localAndPropagatedEntityIds = bd.evaluator.ctr.getLocalAndPropagatedEntityIds(entityIdArray);
    var propagatedEntityIds = localAndPropagatedEntityIds.propagatedEntityIds;
    var localEntityIds = localAndPropagatedEntityIds.localEntityIds;

    bd.model.addModelUpdateElement(propagatedEntityIds,"set","direction",direction,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();

    for(var i=0;i<localEntityIds.length;i++) {
      bd.component.lookup(localEntityIds[i]).localDirection(direction, "set");
    }

    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_label_color"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"},
                 {name:"labelColor",type:"field",fieldName:"COLOR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var labelColor = stackObject.params.labelColor;

    bd.model.addModelUpdateElement(entityIdArray,"set","color",labelColor,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["play_video"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    bd.model.addModelUpdateElement(entityIdArray,"command","playVideo",null,{updateUIForOrigin:true,updateModelForOrigin:false,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["empty_list"] = {
  paramsInfo  : [{name:"currentList",type:"value",valueName:"LIST"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var currentList = stackObject.params.currentList;
    currentList.splice(0,currentList.length);
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["flip_sprite"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"flipType",type:"field",fieldName:"FLIP_TYPE"}],
  evalFunc    : function(block) {
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var flipType = stackObject.params.flipType;
    var flipBoolean = false;
    var flipProperty = "flipHorizontal";

    if(flipType == "LEFT" || flipType == "UPSIDE_DOWN") {
      flipBoolean = true;
    }

    if(flipType == "NOT_UPSIDE_DOWN" || flipType == "UPSIDE_DOWN") {
      flipProperty = "flipVertical";
    }

    bd.model.addModelUpdateElement(entityIdArray,"set",flipProperty,flipBoolean,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["procedures_def"] = {
  evalFunc    : function(block){
    var statementBlock = null;
    if(!bd.evaluator.ctr.functionReturn){
      if(block.statement && block.statement.block){
        statementBlock = block.statement.block;
      }
      //Make sure it returns regardless of return block
      bd.evaluator.ctr.functionReturn = true;
      bd.evaluator.ctr.addToCallStack({block:statementBlock,context:bd.evaluator.ctr.context,callingFunction:bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1].callingFunction});
      bd.evaluator.ctr.evaluateStack();
    } else {
      bd.evaluator.ctr.functionReturn = false;
      //Next block should be null
      bd.evaluator.ctr.nextBlockInCallStack(block.next);
    }
  }
};

bd.evaluator.ctr.configs["procedures_call"] = {
  getParams   : function(block){
    var paramsInfoArray = [];
    var procedureParameterObjects = JSON.parse(block.mutation._parameter_objects);
    for (var i=0,parameterObject; parameterObject = procedureParameterObjects[i]; i++) {
      paramsInfoArray.push({name:parameterObject.name,type:"value",valueName:"CALL"+i});
    }
    // For function name
    paramsInfoArray.push({name:"callName",type:"field",fieldName:block.field._name});
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var callName = stackObject.params.callName;
    var newContext = {};
    var procedureParameterObjects = JSON.parse(block.mutation._parameter_objects);
    for(var i=0;i<procedureParameterObjects.length;i++){
      if(bd.util.containsPrefix(procedureParameterObjects[i].type,"type") && bd.util.removePrefix(procedureParameterObjects[i].type,"type") == "value"){
        newContext[procedureParameterObjects[i].name] = {type:"value",value:stackObject.params[procedureParameterObjects[i].name]};
      } else {
        newContext[procedureParameterObjects[i].name] = stackObject.params[procedureParameterObjects[i].name];
      }
    }
    var oldContext = bd.evaluator.ctr.context;
    bd.evaluator.ctr.context = newContext;
    if(block.mutation._call_type == "thread" || block.mutation._call_type == null){
      bd.evaluator.ctr.nextBlockInCallStackNoEvaluation(block.next);
      bd.evaluator.ctr.evalEntityScripts(oldContext["callingEntity"],"procedures_def",[{titleIndex:0,value:callName}],newContext,true,{callIndex:bd.evaluator.ctr.callStack.length-1,paramName:null});
    } else {
      //Single threaded
      if(block.mutation._call_type == "statement"){
        bd.evaluator.ctr.nextBlockInCallStackNoEvaluation(block.next);
      }
      if(block.mutation._call_type == "value" && stackObject.returnValue != null){
        bd.evaluator.ctr.returnHandler(stackObject.returnValue,block.returnsEntity);
        return;
      }
      var functionBlock = bd.evaluator.ctr.evalEntityScripts(oldContext["callingEntity"],"procedures_def",[{titleIndex:0,value:callName}],newContext,false,null,false,true);
      functionBlock = (functionBlock == null ? null : functionBlock);
      bd.evaluator.ctr.addToCallStack({block:functionBlock,context:newContext,callingFunction:bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1].callingFunction},false,false);
      bd.evaluator.ctr.evaluateStack();
    }
  }
};

bd.evaluator.ctr.configs["procedures_return"] = {
  getParams   : function(block){
    var paramsInfoArray = [];
    if(block.mutation._returns_value == 1){
      paramsInfoArray.push({name:"val",type:"value",valueName:"VALUE"});
    }
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var returnValue = stackObject.params.val;
    var cutoffIndex = null;
    for(var i=0;i<bd.evaluator.ctr.callStack.length;i++){
      var stackObj = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1-i];
      if(stackObj.block._type == "procedures_def"){
        cutoffIndex = bd.evaluator.ctr.callStack.length-1-i+1;//1 after the loop is the cutoff
        break;
      }
    }

    if(cutoffIndex != null){
      bd.evaluator.ctr.callStack.splice(cutoffIndex,bd.evaluator.ctr.callStack.length);
      //Access the "procedure_call" that needs the return value
      var previousStackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-2];
      if(previousStackObject.block._type == "procedures_call" && previousStackObject.block.mutation._call_type == "value"){
        if(block.mutation._returns_value == 1){
          previousStackObject.returnValue = (returnValue == null ? "nullObject" : returnValue);
        } else {
          previousStackObject.returnValue = "nullObject";
        }
      }
      bd.evaluator.ctr.evaluateStack();
    } else {
      //TODO: Throw an error -- return block should only be used in a function def!
    }
  }
};

bd.evaluator.ctr.configs["animation_call"] = bd.evaluator.ctr.configs["procedures_call"];

bd.evaluator.ctr.configs["add_to_trait_list"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"traitDefIdArray",type:"entity",fieldName:"TRAIT"},
                 {name:"val",type:"value",valueName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var value = stackObject.params.val;
    var entityIds = stackObject.params.entityIdArray;
    var traitDefId = stackObject.params.traitDefIdArray;
    var traitIds = bd.evaluator.ctr.getTraitIds(entityIds,traitDefId);

    bd.model.addModelUpdateElement(traitIds,"push","value",value,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_label_text"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"},
                 {name:"labelText",type:"value",valueName:"x"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var labelText = String(stackObject.params.labelText);

    bd.model.addModelUpdateElement(entityIdArray,"set","text",labelText,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_trait"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"ENTITY"},
                 {name:"traitDefIdArray",type:"entity",fieldName:"TRAIT"},
                 {name:"val",type:"value",valueName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIds = stackObject.params.entityIdArray;
    var traitDefId = stackObject.params.traitDefIdArray[0];
    var value = stackObject.params.val;
    var traitIdsToUpdate = [];
    for(var i=0;i<entityIds.length;i++){
      var entityTraitIds = bd.entityLookup[entityIds[i]].traitIds;
      for(var k=0;k<entityTraitIds.length;k++){
        if(bd.entityLookup[entityTraitIds[k]].traitDefId == traitDefId){
          traitIdsToUpdate.push(entityTraitIds[k]);
          break;
        }
      }
    }
    var setOrChange = (block._type == "change_trait" ? "change" : "set");
    bd.model.addModelUpdateElement(traitIdsToUpdate,setOrChange,"value",value,{updateUIForOrigin:false,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["change_trait"] = bd.evaluator.ctr.configs["set_trait"];

bd.evaluator.ctr.configs["next_costume"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    for(var i=0;i<entityIdArray.length;i++){
      var childEntityId = entityIdArray[i];
      //var costumeId = bd.util.removeIdPrefix(block.title[1].toString());
      var costumeIds = bd.component.lookup(childEntityId).getCostumeIds();
      var oldCostumeId = bd.entityLookup[childEntityId].costumeId;
      var nextCostumeId = costumeIds[0];
      for(var k=0;k<costumeIds.length-1;k++){
        if(costumeIds[k] == oldCostumeId){
          nextCostumeId = costumeIds[k+1];
        }
      }
      bd.model.addModelUpdateElement([childEntityId],"set","costumeId",nextCostumeId,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    }
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_width_height"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"},
                {name:"dimension",type:"field",fieldName:"DIMENSION"},
                {name:"val",type:"value",valueName:"x"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var dimension = stackObject.params.dimension;
    var entityIdArray = stackObject.params.entityIdArray;
    var value = stackObject.params.val;

    bd.model.addModelUpdateElement(entityIdArray,"set",dimension,value,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["show_hide_pieces"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"},
                {name:"hideOrShow",type:"field",fieldName:"MODE"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var hideOrShow = stackObject.params.hideOrShow;
    var entityIdArray = stackObject.params.entityIdArray;
    var visible = true;
    if(hideOrShow == "show"){
      visible = true;
    } else {
      visible = false;
    }

    bd.model.addModelUpdateElement(entityIdArray,"set","visible",visible,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["controls_if"] = {
  getParams   : function(block){
    var paramsInfoArray = [];
    if(!(bd.util.isArray(block.value))){
      paramsInfoArray.push({name:block.value._name,type:"value",valueName:block.value._name});
    } else {
      for(var i=0;i<block.value.length;i++){
        paramsInfoArray.push({name:block.value[i]._name,type:"value",valueName:block.value[i]._name});
      }
    }
    return paramsInfoArray;
  },
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var valueNum = -1;
    if(!(bd.util.isArray(block.value))){
      if(stackObject.params[block.value._name]){
        valueNum = block.value._name.replace("IF","");
      }
    } else {
      for(var i=0;i<block.value.length;i++){
        if(stackObject.params[block.value[i]._name]){
          valueNum = block.value[i]._name.replace("IF","");
          break;
        }
      }
    }
    if(valueNum != -1){
      if(!(bd.util.isArray(block.statement))){
        if(block.statement && block.statement._name == ("DO" + valueNum)){
          if(block.next != null){
            bd.evaluator.ctr.addToCallStack({block:block.next.block,context:bd.evaluator.ctr.context,callingFunction:bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1].callingFunction},false,true);
          }
          bd.evaluator.ctr.nextBlockInCallStack(block.statement);
          return;
        }
      } else {

        for(var i=0;i<block.statement.length;i++){
          if(block.statement[i]._name == ("DO" + valueNum)){
            if(block.next != null){
              bd.evaluator.ctr.addToCallStack({block:block.next.block,context:bd.evaluator.ctr.context,callingFunction:bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1].callingFunction},false,true);
            }
            bd.evaluator.ctr.nextBlockInCallStack(block.statement[i]);
            return;
          }
        }

      }
    } else if((bd.util.isArray(block.statement)) && block.statement[block.statement.length-1]._name == "ELSE"){
      if(block.next != null){
        bd.evaluator.ctr.addToCallStack({block:block.next.block,context:bd.evaluator.ctr.context,callingFunction:bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1].callingFunction},false,true);
      }
      bd.evaluator.ctr.nextBlockInCallStack(block.statement[block.statement.length-1]);
      return;
    }
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["switch_costume"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"},
                {name:"costumeId",type:"entity",fieldName:"VAR2"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var costumeId = stackObject.params.costumeId;

    bd.model.addModelUpdateElement(entityIdArray,"set","costumeId",costumeId,{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
  }
};

bd.evaluator.ctr.configs["set_costume_num"] = {
  paramsInfo  : [{name:"entityIdArray",type:"entity",fieldName:"VAR"},
                {name:"costumeNum",type:"value",valueName:"COSTUME_NUM"}],
  evalFunc    : function(block){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var entityIdArray = stackObject.params.entityIdArray;
    var costumeNum = stackObject.params.costumeNum;

    if(costumeNum > 0){
      var entityIdAndCostumeIdArray = [];
      for(var i=0;i<entityIdArray.length;i++){
        var childEntityId = entityIdArray[i];
        //var costumeId = bd.util.removeIdPrefix(block.title[1].toString());
        var costumeIds = bd.component.lookup(childEntityId).getCostumeIds()
        if(costumeIds.length > (costumeNum - 1) ){
          bd.model.addModelUpdateElement([childEntityId],"set","costumeId",costumeIds[(costumeNum - 1)],{updateUIForOrigin:true,updateModelForOrigin:true,updateModelInEditor:false,updateUIInEditor:false});
        }
      }
    bd.model.sendUpdates();
    bd.evaluator.ctr.nextBlockInCallStack(block.next);
    }
  }
};

bd.evaluator.ctr.configs["stop_blocks"] = {
  paramsInfo  : [{name:"stopType",type:"field",fieldName:"STOP_TYPE"}],
  evalFunc    : function(block){

    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    var stopType = stackObject.params.stopType;

    if(stopType == "ALL_SCRIPTS_SPRITES" || stopType == "ALL_SPRITES") {
      //stop all sprites
      var physicsEntityObjects = bd.model.getEntityList("phaserPhysicsPieceInstance");
      for(var i=0;i<physicsEntityObjects.length;i++) {
        bd.component.lookup(physicsEntityObjects[i].id).stopMovement();
      }
    }
    if(stopType == 'ALL_SCRIPTS_SPRITES' || stopType == 'ALL_SCRIPTS' || stopType == 'OTHER_SCRIPTS') {
      //stop blocks in timer
      bd.evaluator.ctr.stopAllTimers();
      //clear blocks for tick and to evaluate
      bd.evaluator.ctr.callStackObjectsForTick = [];
      bd.evaluator.ctr.stacksToEvaluate = [];
    }
    if(stopType == 'ALL_SCRIPTS_SPRITES' || stopType == 'ALL_SCRIPTS') {
      //clear current call stack
      bd.evaluator.ctr.callStack = [];
    }
    if(stopType == 'OTHER_SCRIPTS' || stopType == "ALL_SPRITES") {
      bd.evaluator.ctr.nextBlockInCallStack(block.next);
    }
  }
};

// *********************************************** //
// *********************************************** //
// ************* BLOCK HELPER METHODS ************ //
// *********************************************** //
// *********************************************** //

bd.evaluator.ctr.stopAllTimers = function() {
  for(var timerId in bd.evaluator.ctr.activeTimerIds) {
    clearTimeout(timerId);
  }
}

bd.evaluator.ctr.resetJSCallStack = function(){
  setTimeout(
    function(stringifiedPreviousState){
      var previousState = JSON.parse(stringifiedPreviousState);

      bd.evaluator.ctr.callStackObjectsForTick.unshift(previousState.callStack);
      bd.evaluator.ctr.context = previousState.context;
      bd.evaluator.ctr.continuePreviousStack();
    },
    0,
    JSON.stringify({callStack:bd.evaluator.ctr.callStack, context:bd.evaluator.ctr.context})
  );
}

bd.evaluator.ctr.returnHandler = function(value,returnsEntity) {
  var currentStackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
  var targetStackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-2];

  if(returnsEntity){
    targetStackObject.params[targetStackObject.currentParam] = [value];
  } else {
    targetStackObject.params[targetStackObject.currentParam] = value;
  }

  //Should transition to a null nextObject
  bd.evaluator.ctr.nextBlockInCallStack(currentStackObject.block.next);
}

//TODO: Find a different place to set "hasOutput" rather than in this code block itself?
bd.evaluator.ctr.evaluateBlock = function(block){

  bd.evaluator.ctr.evalCounter += 1;

  //Reset JS callstack to prevent overflow
  if(bd.evaluator.ctr.evalCounter >= bd.evaluator.ctr.MAX_CALLS){
    bd.evaluator.ctr.evalCounter = 0;
    bd.evaluator.ctr.resetJSCallStack();
    return;
  }

  //Stop conditions
  if(block == null){
    var poppedStackObject = bd.evaluator.ctr.callStack.pop();

    //if nothing left to evaluate
    if(bd.evaluator.ctr.callStack.length == 0){

      bd.evaluator.ctr.continuePreviousStack();
      //if is animation def, timeout
      return;
    } else {
      //evaluate the next thing on the stack
      var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
      if(stackObject.block && (stackObject.block._type == "controls_forEachTraits" || stackObject.block._type == "controls_forEachEntity")){
        stackObject.context = poppedStackObject.context;
      }
      bd.evaluator.ctr.context = stackObject.context;
      bd.evaluator.ctr.evaluateBlock(stackObject.block);
      return;
    }

  }

  var config = bd.evaluator.ctr.configs[block._type];
  var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
  stackObject.params = (stackObject.params == null ? {} : stackObject.params);
  //Populate paramsInfo for blocks with dynamic parameter set (e.g. controls_if)
  if(config.getParams){
    config.paramsInfo = config.getParams(block);
  }
  //Pass in arguments (parameters) to block
  if(config.paramsInfo){
    for(var i=0, paramObj; paramObj = config.paramsInfo[i]; i++){
      if(bd.evaluator.ctr.blockExecutionError) { break; }
      if(stackObject.params[paramObj.name] == null){
        stackObject.currentParam = paramObj.name;
        switch(paramObj.type){
          case "entity":
            var valueArray = [];
            var blockInput;
            if(block.value) {
              if(!(bd.util.isArray(block.value))){
                valueArray = [block.value];
              } else {
                valueArray = block.value;
              }
            }
            for(var k=0;k<valueArray.length;k++){
              if(valueArray[k]._name == paramObj.fieldName + "_SOCKET"){
                blockInput = valueArray[k].block;
                break;
              }
            }

            if(blockInput !== undefined){
              blockInput.returnsEntity = true;
              var newCallObject = {block:blockInput,context:stackObject.context};
              bd.evaluator.ctr.addToCallStack(newCallObject,false);
              bd.evaluator.ctr.evaluateStack();
              return;
            } else {
              stackObject.params[paramObj.name] = bd.evaluator.ctr.entityTitleToEntityIdArray(paramObj.fieldName,block);
            }
            break;
          case "entityClass":
            stackObject.params[paramObj.name] = [];
            var entityText = bd.evaluator.ctr.getTitleTextFromBlock(paramObj.fieldName,block);
            var entityId = bd.util.removeIdPrefix(entityText);
            var instanceIds = bd.model.entityLookup(entityId).instanceIds;
            for(var i=0;i<instanceIds.length;i++){
              stackObject.params[paramObj.name].push(instanceIds[i]);
            }
            break;
          case "value":
            var valueObj = bd.evaluator.ctr.getValueFromBlock(paramObj.valueName,block);
            if(valueObj == null){
              stackObject.params[paramObj.name] = "nullObject";
              //TODO: Throw warning -- empty sockets!
            } else {
              var blockInput = valueObj.block;
              var newCallObject = {block:blockInput,context:stackObject.context};
              bd.evaluator.ctr.addToCallStack(newCallObject,false);
              bd.evaluator.ctr.evaluateStack();
              return;
            }
            break;
          case "field":
            stackObject.params[paramObj.name] = bd.evaluator.ctr.getTitleTextFromBlock(paramObj.fieldName,block);
            break;
          case "fieldVariable":
            stackObject.params[paramObj.name] = bd.evaluator.ctr.getTitleFromBlock(paramObj.fieldName,block);
            break;
          case "variableName":
            var iteratorInfo = bd.evaluator.ctr.getValueFromBlock(paramObj.valueName,block)
            stackObject.params[paramObj.name] = bd.evaluator.ctr.getTitleFromBlock(iteratorInfo._name,iteratorInfo.block)
            break;
        }
      }
    }
  }

  //Execute the block
  if(!bd.evaluator.ctr.blockExecutionError){
    config.evalFunc(block);
  } else {
    bd.evaluator.ctr.blockExecutionError = false;
    bd.evaluator.ctr.callStack = [];
    bd.evaluator.ctr.continuePreviousStack();
  }
}

bd.evaluator.ctr.getTraitIds = function(entityIds,traitDefId){
  var traitIds = [];
  for(var i=0;i<entityIds.length;i++){
    var entity = bd.entityLookup[entityIds[i]];
    for(var k=0;k<entity.traitIds.length;k++){
      if(bd.entityLookup[entity.traitIds[k]].traitDefId == traitDefId){
        traitIds.push(entity.traitIds[k]);
        break;
      }
    }
  }
  return traitIds;
}

bd.evaluator.ctr.isEventTriggeredByEntity = function(entityText,entityId){
  var parentId = bd.entityLookup[entityId].parentId;

  if (bd.util.isAnyOrAll(entityText)){
    return true;
  } else if(bd.util.removeIdPrefix(entityText) == entityId){
    return true;
  } else if(bd.util.removeIdPrefix(entityText) == parentId){
    return true;
  } else {
    return false;
  }

}

bd.evaluator.ctr.isEventTriggeredByEntityNEW = function(matchingEntityIds,entityId){
  var parentId = bd.entityLookup[entityId].parentId;
  for(var i=0;i<matchingEntityIds.length;i++){
    if(matchingEntityIds[i] == entityId || matchingEntityIds[i] == parentId){
      return true;
    }
  }
  return false;
}

//input - "id:14" | "any:pieceInstance" | "context:clickedPiece"
//output - entityIdArray
bd.evaluator.ctr.entityTitleToEntityIdArray = function(titleName,block){
  var titleArray = [];
  var entityText;
  var entityIdArray = [];
  var entityId;

  if (block.field != null) {
    if(!(bd.util.isArray(block.field))){
      titleArray = [block.field];
    } else {
      titleArray = block.field;
    }
  }

  var valueArray = [];
  if(block.value) {
    if(!(bd.util.isArray(block.value))){
      valueArray = [block.value];
    } else {
      valueArray = block.value;
    }
  }

  for(var i=0;i<titleArray.length;i++){
    if(titleArray[i]._name == titleName){
      entityText = titleArray[i].__text;
      break;
    }
  }
  for(var k=0;k<valueArray.length;k++){
    if(valueArray[k]._name == titleName + "_SOCKET"){
      entityId = bd.evaluator.ctr.evalValue(valueArray[k]);
      break;
    }
  }
  if(entityText !== undefined){
    if(bd.util.containsPrefix(entityText,"id")){
      entityId = bd.util.removeIdPrefix(entityText);
    } else if(bd.util.isAnyOrAll(entityText)){

    } else if(bd.util.containsPrefix(entityText,"pointer:")){
      return [entityText];
    } else {
      entityId = bd.component.lookup(bd.model.getGameInfo().id).getGlobalVariable(entityText);
      if(entityId == null) {
        entityId = bd.evaluator.ctr.context[entityText];
      }
    }

    if(typeof entityId == "object" && entityId.type == "value"){
      return [entityId.value];
    }

    var isAnyOrAll = bd.util.isAnyOrAll(entityText);
    if(isAnyOrAll){
      if(isAnyOrAll[0] == "random"){
        var entityArray = bd.model.getEntityList(isAnyOrAll[1]);
        entityIdArray.push(entityArray[Math.floor(Math.random()*entityArray.length)].id)
      } else {
        var entityArray = bd.model.getEntityList(isAnyOrAll[1])
        for(var i=0;i<entityArray.length;i++){
          entityIdArray.push(entityArray[i].id);
        }
      }
      return entityIdArray;
    }
  }




  if(entityId === undefined){
    return entityIdArray;
  }

  var entity = bd.model.entityLookup(entityId);

  //if entity does not exist, just return null
  if(entity == null) {
    return [entityId];
  }

  //if share mode is local, return player's local copy of entity
  if(entity.shareMode == "local" && entity.playerId == null && bd.component.lookup(entityId).classOrInstance == "instance") {
    var playerLocalEntityId = entity.playerIdsToChildInstanceIds[bd.player.ctr.playerId];
    //check that entity actually exists
    if(bd.model.entityLookup(playerLocalEntityId) == null){
      //Throw debug error
      var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
      bd.debug.ctr.logMsg("deletedEntityReference", {"blockId":block._id, "scriptPageId":stackObject.context["callingEntity"]});
      bd.evaluator.ctr.blockExecutionError = true;
      return null;
    }
    return [playerLocalEntityId];
  }

  if(bd.entityLookup[entityId].shareMode == "perPlayer" && bd.model.isInstance(entityId) && bd.entityLookup[entityId].playerId == null){
    //entityIdArray = [entityId];
    //entityIdArray = bd.evaluator.ctr.entityTitleToEntityIdArray(titleName + ,block);
    var playerIds = [];
    var playerId;
    if(block.mutation && block.mutation['_' + titleName.toLowerCase() + '_entity_player']){
      var entityText = block.mutation['_' + titleName.toLowerCase() + '_entity_player'];
      if(bd.util.containsPrefix(entityText,"id")){
        playerId = bd.util.removeIdPrefix(entityText);
      } else if(bd.util.isAnyOrAll(entityText)){

      } else {
        playerId = bd.evaluator.ctr.context[entityText];
      }

      if(playerId !== undefined){
        playerIds = [playerId];
      }
      var isAnyOrAll = bd.util.isAnyOrAll(entityText);
      if(isAnyOrAll){
        if(isAnyOrAll[0] == "random"){
          var playerArray = bd.model.getEntityList(isAnyOrAll[1]);
          playerIds.push(playerArray[Math.floor(Math.random()*playerArray.length)].id)
        } else {
          var playerArray = bd.model.getEntityList(isAnyOrAll[1]);
          for(var i=0;i<playerArray.length;i++){
            playerIds.push(playerArray[i].id);
          }
        }
      }
      entityIdArray = bd.evaluator.ctr.getEntityPlayerInstanceIds(playerIds,entityId);

    } else if(block.mutation && block.mutation['_'+ titleName.toLowerCase() + '_entity_player_type']){
      var valueArray;
      if(!(bd.util.isArray(block.value))){
        valueArray = [block.value];
      } else {
        valueArray = block.value;
      }
      for(var i=0;i<valueArray.length;i++){
        if(valueArray[i]._name == titleName + "_PLAYER_SOCKET"){
          var playerId = bd.evaluator.ctr.evalValue(valueArray[i]);
          playerIds = [playerId]
          break;
        }
      }
      entityIdArray = bd.evaluator.ctr.getEntityPlayerInstanceIds(playerIds,entityId);
    }
  } else {
    entityIdArray = [entityId];
  }

  return entityIdArray;

}

bd.evaluator.ctr.getEntityPlayerInstanceIds = function(playerIds,instanceId){
  var entityIdArray = [];

  //check if instanceId is actually a class id
  if(bd.entityLookup[instanceId].playerIdsToChildInstanceIds == null && bd.entityLookup[instanceId].instanceIds){
    for(var i=0;i<bd.entityLookup[instanceId].instanceIds.length;i++){
      var actualInstanceId = bd.entityLookup[instanceId].instanceIds[i];
      for(var k=0;k<playerIds.length;k++){
        if(playerIds[k] == bd.entityLookup[actualInstanceId].playerId){
          entityIdArray.push(actualInstanceId);
          break;
        }
      }
    }
    return entityIdArray;
  }

  if(playerIds.length >1){
    for(var id in bd.entityLookup[instanceId].playerIdsToChildInstanceIds){
      entityIdArray.push(bd.entityLookup[instanceId].playerIdsToChildInstanceIds[id]);
    }
  } else {
    entityIdArray = [bd.entityLookup[instanceId].playerIdsToChildInstanceIds[playerIds[0]]];
  }

  return entityIdArray;
}

bd.evaluator.ctr.getTitleFromBlock = function(titleName,block){
  var titleArray;
  if(!(bd.util.isArray(block.field))){
    titleArray = [block.field];
  } else {
    titleArray = block.field;
  }

  for(var i=0;i<titleArray.length;i++){
    if(titleArray[i]._name == titleName){
      return titleArray[i];
    }
  }
  return null;
}

bd.evaluator.ctr.getTitleTextFromBlock = function(titleName,block){
  var title = bd.evaluator.ctr.getTitleFromBlock(titleName,block);
  if(title == null){
    return null;
  } else {
    return title.__text;
  }
}


bd.evaluator.ctr.getValueFromBlock = function(valueName,block){
  var valueArray;
  if(!(bd.util.isArray(block.value))){
    valueArray = [block.value];
  } else {
    valueArray = block.value;
  }

  for(var i=0;i<valueArray.length;i++){
    if(valueArray[i] && valueArray[i]._name == valueName){
      return valueArray[i];
    }
  }
  return null;
}

bd.evaluator.ctr.evalNumber = function(block){
  var value = parseFloat(bd.evaluator.ctr.evalValue(block));
  if(isNaN(value)){
    var stackObject = bd.evaluator.ctr.callStack[bd.evaluator.ctr.callStack.length-1];
    bd.debug.ctr.logMsg("emptyMathBlock", {blockId:"No block id", scriptPageId:stackObject.context["callingEntity"]});
    return 0;
  } else {
    return value;
  }
}

bd.evaluator.ctr.getLocalAndPropagatedEntityIds = function(entityIds) {
  var localEntityIds = [];
  var propagatedEntityIds = [];
  var shareMode;
  for(var i=0;i<entityIds.length;i++) {
    shareMode = bd.model.entityLookup(entityIds[i]).shareMode;
    if(shareMode == "local") {
      localEntityIds.push(entityIds[i]);
    } else {
      propagatedEntityIds.push(entityIds[i]);
    }
  }
  return {localEntityIds:localEntityIds,propagatedEntityIds:propagatedEntityIds};
}

bd.evaluator.ctr.entityIdTextToAngle = function(entityId1,entityId2) {
  var entityIds = [entityId1,entityId2];
  var xyVarArray = [{x:0,y:0},{x:0,y:0}];
  for(var i=0, entityId;entityId = entityIds[i];i++) {
    if(bd.util.containsPrefix(entityId,"pointer:")) {
      var pointerObject = bd.phaser.ctr.entityTextToPointerObject(entityId);
      xyVarArray[i].x = pointerObject.clientX;
      xyVarArray[i].y = pointerObject.clientY;
    } else {
      var componentObject = bd.component.lookup(entityId);
      xyVarArray[i].x = componentObject.getXOrY('x');
      xyVarArray[i].y = componentObject.getXOrY('y');
    }
  }

  var dy = xyVarArray[1].y - xyVarArray[0].y;
  var dx = xyVarArray[1].x - xyVarArray[0].x;

  var angle = (180/Math.PI) * Math.atan2(dy,dx);
  return angle;
}