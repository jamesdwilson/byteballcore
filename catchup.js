/*jslint node: true */
const async = require('async');
const _ = require('lodash');
const storage = require('./storage.js');
const objectHash = require("./object_hash.js");
const db = require('./db.js');
const mutex = require('./mutex.js');
const validation = require('./validation.js');
const witnessProof = require('./witness_proof.js');



function prepareCatchupChain(catchupRequest, callbacks){
	if (!catchupRequest)
		return callbacks.ifError("no catchup request");
	const last_stable_mci = catchupRequest.last_stable_mci;
	const last_known_mci = catchupRequest.last_known_mci;
	const arrWitnesses = catchupRequest.witnesses;
	
	if (typeof last_stable_mci !== "number")
		return callbacks.ifError("no last_stable_mci");
	if (typeof last_known_mci !== "number")
		return callbacks.ifError("no last_known_mci");
	if (last_stable_mci >= last_known_mci && (last_known_mci > 0 || last_stable_mci > 0))
		return callbacks.ifError("last_stable_mci >= last_known_mci");
	if (!Array.isArray(arrWitnesses))
		return callbacks.ifError("no witnesses");

	mutex.lock(['prepareCatchupChain'], unlock => {
		const start_ts = Date.now();
		const objCatchupChain = {
			unstable_mc_joints: [], 
			stable_last_ball_joints: [],
			witness_change_and_definition_joints: []
		};
		let last_ball_unit = null;
		async.series([
			cb => { // check if the peer really needs hash trees
				db.query("SELECT is_stable FROM units WHERE is_on_main_chain=1 AND main_chain_index=?", [last_known_mci], rows => {
					if (rows.length === 0)
						return cb("already_current");
					if (rows[0].is_stable === 0)
						return cb("already_current");
					cb();
				});
			},
			cb => {
				witnessProof.prepareWitnessProof(
					arrWitnesses, last_stable_mci, 
					(
                        err,
                        arrUnstableMcJoints,
                        arrWitnessChangeAndDefinitionJoints,
                        _last_ball_unit,
                        _last_ball_mci
                    ) => {
						if (err)
							return cb(err);
						objCatchupChain.unstable_mc_joints = arrUnstableMcJoints;
						if (arrWitnessChangeAndDefinitionJoints.length > 0)
							objCatchupChain.witness_change_and_definition_joints = arrWitnessChangeAndDefinitionJoints;
						last_ball_unit = _last_ball_unit;
						cb();
					}
				);
			},
			cb => { // jump by last_ball references until we land on or behind last_stable_mci
				if (!last_ball_unit)
					return cb();
				goUp(last_ball_unit);

				function goUp(unit){
					storage.readJointWithBall(db, unit, objJoint => {
						objCatchupChain.stable_last_ball_joints.push(objJoint);
						storage.readUnitProps(db, unit, ({main_chain_index}) => {
							(main_chain_index <= last_stable_mci) ? cb() : goUp(objJoint.unit.last_ball_unit);
						});
					});
				}
			}
		], err => {
			if (err === "already_current")
				callbacks.ifOk({status: "current"});
			else if (err)
				callbacks.ifError(err);
			else
				callbacks.ifOk(objCatchupChain);
			console.log(`prepareCatchupChain since mci ${last_stable_mci} took ${Date.now()-start_ts}ms`);
			unlock();
		});
	});
}



function processCatchupChain(catchupChain, peer, callbacks){
	if (catchupChain.status === "current")
		return callbacks.ifCurrent();
	if (!Array.isArray(catchupChain.unstable_mc_joints))
		return callbacks.ifError("no unstable_mc_joints");
	if (!Array.isArray(catchupChain.stable_last_ball_joints))
		return callbacks.ifError("no stable_last_ball_joints");
	if (catchupChain.stable_last_ball_joints.length === 0)
		return callbacks.ifError("stable_last_ball_joints is empty");
	if (!catchupChain.witness_change_and_definition_joints)
		catchupChain.witness_change_and_definition_joints = [];
	if (!Array.isArray(catchupChain.witness_change_and_definition_joints))
		return callbacks.ifError("witness_change_and_definition_joints must be array");
	
	witnessProof.processWitnessProof(
		catchupChain.unstable_mc_joints, catchupChain.witness_change_and_definition_joints, true, 
		(err, arrLastBallUnits, assocLastBallByLastBallUnit) => {
			
			if (err)
				return callbacks.ifError(err);
		
			const objFirstStableJoint = catchupChain.stable_last_ball_joints[0];
			const objFirstStableUnit = objFirstStableJoint.unit;
			if (arrLastBallUnits.indexOf(objFirstStableUnit.unit) === -1)
				return callbacks.ifError("first stable unit is not last ball unit of any unstable unit");
			let last_ball_unit = objFirstStableUnit.unit;
			let last_ball = assocLastBallByLastBallUnit[last_ball_unit];
			if (objFirstStableJoint.ball !== last_ball)
				return callbacks.ifError(`last ball and last ball unit do not match: ${objFirstStableJoint.ball}!==${last_ball}`);

			// stable joints
			const arrChainBalls = [];
			for (let i=0; i<catchupChain.stable_last_ball_joints.length; i++){
				const objJoint = catchupChain.stable_last_ball_joints[i];
				const objUnit = objJoint.unit;
				if (!objJoint.ball)
					return callbacks.ifError("stable but no ball");
				if (!validation.hasValidHashes(objJoint))
					return callbacks.ifError("invalid hash");
				if (objUnit.unit !== last_ball_unit)
					return callbacks.ifError("not the last ball unit");
				if (objJoint.ball !== last_ball)
					return callbacks.ifError("not the last ball");
				if (objUnit.last_ball_unit){
					last_ball_unit = objUnit.last_ball_unit;
					last_ball = objUnit.last_ball;
				}
				arrChainBalls.push(objJoint.ball);
			}
			arrChainBalls.reverse();


			let unlock = null;
			async.series([
				cb => {
					mutex.lock(["catchup_chain"], _unlock => {
						unlock = _unlock;
						db.query("SELECT 1 FROM catchup_chain_balls LIMIT 1", ({length}) => {
							(length > 0) ? cb("duplicate") : cb();
						});
					});
				},
				cb => { // adjust first chain ball if necessary and make sure it is the only stable unit in the entire chain
					db.query(
						"SELECT is_stable, is_on_main_chain, main_chain_index FROM balls JOIN units USING(unit) WHERE ball=?", 
						[arrChainBalls[0]], 
						rows => {
							if (rows.length === 0){
								if (storage.isGenesisBall(arrChainBalls[0]))
									return cb();
								return cb(`first chain ball ${arrChainBalls[0]} is not known`);
							}
							const objFirstChainBallProps = rows[0];
							if (objFirstChainBallProps.is_stable !== 1)
								return cb(`first chain ball ${arrChainBalls[0]} is not stable`);
							if (objFirstChainBallProps.is_on_main_chain !== 1)
								return cb(`first chain ball ${arrChainBalls[0]} is not on mc`);
							storage.readLastStableMcUnitProps(db, ({main_chain_index, ball}) => {
								const last_stable_mci = main_chain_index;
								if (objFirstChainBallProps.main_chain_index > last_stable_mci) // duplicate check
									return cb(`first chain ball ${arrChainBalls[0]} mci is too large`);
								if (objFirstChainBallProps.main_chain_index === last_stable_mci) // exact match
									return cb();
								arrChainBalls[0] = ball; // replace to avoid receiving duplicates
								if (!arrChainBalls[1])
									return cb();
								db.query("SELECT is_stable FROM balls JOIN units USING(unit) WHERE ball=?", [arrChainBalls[1]], rows2 => {
									if (rows2.length === 0)
										return cb();
									const objSecondChainBallProps = rows2[0];
									if (objSecondChainBallProps.is_stable === 1)
										return cb(`second chain ball ${arrChainBalls[1]} must not be stable`);
									cb();
								});
							});
						}
					);
				},
				cb => { // validation complete, now write the chain for future downloading of hash trees
					const arrValues = arrChainBalls.map(ball => `(${db.escape(ball)})`);
					db.query(`INSERT INTO catchup_chain_balls (ball) VALUES ${arrValues.join(', ')}`, () => {
						cb();
					});
				}
			], err => {
				unlock();
				err ? callbacks.ifError(err) : callbacks.ifOk();
			});

		}
	);
}

function readHashTree(hashTreeRequest, callbacks){
	if (!hashTreeRequest)
		return callbacks.ifError("no hash tree request");
	const from_ball = hashTreeRequest.from_ball;
	const to_ball = hashTreeRequest.to_ball;
	if (typeof from_ball !== 'string')
		return callbacks.ifError("no from_ball");
	if (typeof to_ball !== 'string')
		return callbacks.ifError("no to_ball");
	let from_mci;
	let to_mci;
	db.query(
		"SELECT is_stable, is_on_main_chain, main_chain_index, ball FROM balls JOIN units USING(unit) WHERE ball IN(?,?)", 
		[from_ball, to_ball], 
		rows => {
			if (rows.length !== 2)
				return callbacks.ifError("some balls not found");
			for (let i=0; i<rows.length; i++){
				const props = rows[i];
				if (props.is_stable !== 1)
					return callbacks.ifError("some balls not stable");
				if (props.is_on_main_chain !== 1)
					return callbacks.ifError("some balls not on mc");
				if (props.ball === from_ball)
					from_mci = props.main_chain_index;
				else if (props.ball === to_ball)
					to_mci = props.main_chain_index;
			}
			if (from_mci >= to_mci)
				return callbacks.ifError("from is after to");
			const arrBalls = [];
			const op = (from_mci === 0) ? ">=" : ">"; // if starting from 0, add genesis itself
			db.query(
				`SELECT unit, ball, content_hash FROM units LEFT JOIN balls USING(unit) \n\
                WHERE main_chain_index ${op} ? AND main_chain_index<=? ORDER BY main_chain_index, \`level\``, 
				[from_mci, to_mci], 
				ball_rows => {
					async.eachSeries(
						ball_rows,
						(objBall, cb) => {
							if (!objBall.ball)
								throw Error(`no ball for unit ${objBall.unit}`);
							if (objBall.content_hash)
								objBall.is_nonserial = true;
							delete objBall.content_hash;
							db.query(
								"SELECT ball FROM parenthoods LEFT JOIN balls ON parent_unit=balls.unit WHERE child_unit=? ORDER BY ball", 
								[objBall.unit],
								parent_rows => {
									if (parent_rows.some(({ball}) => !ball))
										throw Error("some parents have no balls");
									if (parent_rows.length > 0)
										objBall.parent_balls = parent_rows.map(({ball}) => ball);
									db.query(
										"SELECT ball FROM skiplist_units LEFT JOIN balls ON skiplist_unit=balls.unit WHERE skiplist_units.unit=? ORDER BY ball", 
										[objBall.unit],
										srows => {
											if (srows.some(({ball}) => !ball))
												throw Error("some skiplist units have no balls");
											if (srows.length > 0)
												objBall.skiplist_balls = srows.map(({ball}) => ball);
											arrBalls.push(objBall);
											cb();
										}
									);
								}
							);
						},
						() => {
							callbacks.ifOk(arrBalls);
						}
					);
				}
			);
		}
	);
}

function processHashTree(arrBalls, callbacks){
	if (!Array.isArray(arrBalls))
		return callbacks.ifError("no balls array");
	mutex.lock(["hash_tree"], unlock => {
		
		db.query("SELECT 1 FROM hash_tree_balls LIMIT 1", ht_rows => {
			//if (ht_rows.length > 0) // duplicate
			//    return unlock();
			
			db.takeConnectionFromPool(conn => {
				
				conn.query("BEGIN", () => {
					
					let max_mci = null;
					async.eachSeries(
						arrBalls,
						(objBall, cb) => {
							if (typeof objBall.ball !== "string")
								return cb("no ball");
							if (typeof objBall.unit !== "string")
								return cb("no unit");
							if (!storage.isGenesisUnit(objBall.unit)){
								if (!Array.isArray(objBall.parent_balls))
									return cb("no parents");
							}
							else if (objBall.parent_balls)
								return cb("genesis with parents?");
							if (objBall.ball !== objectHash.getBallHash(objBall.unit, objBall.parent_balls, objBall.skiplist_balls, objBall.is_nonserial))
								return cb(`wrong ball hash, ball ${objBall.ball}, unit ${objBall.unit}`);

							function addBall(){
								// insert even if it already exists in balls, because we need to define max_mci by looking outside this hash tree
								conn.query(`INSERT ${conn.getIgnore()} INTO hash_tree_balls (ball, unit) VALUES(?,?)`, [objBall.ball, objBall.unit], () => {
									cb();
									//console.log("inserted unit "+objBall.unit, objBall.ball);
								});
							}
							
							function checkSkiplistBallsExist(){
								if (!objBall.skiplist_balls)
									return addBall();
								conn.query(
									"SELECT ball FROM hash_tree_balls WHERE ball IN(?) UNION SELECT ball FROM balls WHERE ball IN(?)",
									[objBall.skiplist_balls, objBall.skiplist_balls],
									({length}) => {
										if (length !== objBall.skiplist_balls.length)
											return cb("some skiplist balls not found");
										addBall();
									}
								);
							}

							if (!objBall.parent_balls)
								return checkSkiplistBallsExist();
							conn.query("SELECT ball FROM hash_tree_balls WHERE ball IN(?)", [objBall.parent_balls], rows => {
								//console.log(rows.length+" rows", objBall.parent_balls);
								if (rows.length === objBall.parent_balls.length)
									return checkSkiplistBallsExist();
								const arrFoundBalls = rows.map(({ball}) => ball);
								const arrMissingBalls = _.difference(objBall.parent_balls, arrFoundBalls);
								conn.query(
									"SELECT ball, main_chain_index, is_on_main_chain FROM balls JOIN units USING(unit) WHERE ball IN(?)", 
									[arrMissingBalls], 
									rows2 => {
										if (rows2.length !== arrMissingBalls.length)
											return cb(`some parents not found, unit ${objBall.unit}`);
										for (let i=0; i<rows2.length; i++){
											const props = rows2[i];
											if (props.is_on_main_chain === 1 && (props.main_chain_index > max_mci || max_mci === null))
												max_mci = props.main_chain_index;
										}
										checkSkiplistBallsExist();
									}
								);
							});
						},
						error => {
							
							function finish(err){
								conn.query(err ? "ROLLBACK" : "COMMIT", () => {
									conn.release();
									unlock();
									err ? callbacks.ifError(err) : callbacks.ifOk();
								});
							}

							if (error)
								return finish(error);
							
							// it is ok that max_mci === null as the 2nd tree does not touch finished balls
							//if (max_mci === null && !storage.isGenesisUnit(arrBalls[0].unit))
							//    return finish("max_mci not defined");
							
							// check that the received tree matches the first pair of chain elements
							conn.query(
								"SELECT ball, main_chain_index \n\
								FROM catchup_chain_balls LEFT JOIN balls USING(ball) LEFT JOIN units USING(unit) \n\
								ORDER BY member_index LIMIT 2", 
								rows => {
									
									if (rows.length !== 2)
										return finish("expecting to have 2 elements in the chain");
									// removed: the main chain might be rebuilt if we are sending new units while syncing
								//	if (max_mci !== null && rows[0].main_chain_index !== null && rows[0].main_chain_index !== max_mci)
								//		return finish("max mci doesn't match first chain element: max mci = "+max_mci+", first mci = "+rows[0].main_chain_index);
									if (rows[1].ball !== arrBalls[arrBalls.length-1].ball)
										return finish("tree root doesn't match second chain element");
									// remove the last chain element, we now have hash tree instead
									conn.query("DELETE FROM catchup_chain_balls WHERE ball=?", [rows[0].ball], () => {
										
										purgeHandledBallsFromHashTree(conn, finish);
									});
								}
							);
						}
					);
				});
			});
		});
	});
}

function purgeHandledBallsFromHashTree(conn, onDone){
	conn.query("SELECT ball FROM hash_tree_balls CROSS JOIN balls USING(ball)", rows => {
		if (rows.length === 0)
			return onDone();
		const arrHandledBalls = rows.map(({ball}) => ball);
		conn.query("DELETE FROM hash_tree_balls WHERE ball IN(?)", [arrHandledBalls], () => {
			onDone();
		});
	});
}

exports.prepareCatchupChain = prepareCatchupChain;
exports.processCatchupChain = processCatchupChain;
exports.readHashTree = readHashTree;
exports.processHashTree = processHashTree;
exports.purgeHandledBallsFromHashTree = purgeHandledBallsFromHashTree;

