.data

# =========================================================
# PARK-X MIPS BACKEND
# =========================================================

MAX_SLOTS:          .word 30
MAX_RECORDS:        .word 30

next_parking_id:    .word 1001
active_count:       .word 0
completed_count:    .word 0
transaction_count:  .word 0
revenue:            .word 0

# 30 parking slots: 0 = available, 1 = occupied
slots:              .space 120

# Each vehicle record:
# parking_id, slot, payment, active_flag
active_records:     .space 480

completed_records:  .space 480

vehicle_buffer:     .space 64
command_buffer:     .space 128
type_buffer:        .space 32

newline:            .asciiz "\n"
pipe:               .asciiz "|"

ready_msg:          .asciiz "READY\n"

entry_cmd:          .asciiz "ENTRY"
exit_cmd:           .asciiz "EXIT"
dashboard_cmd:      .asciiz "DASHBOARD"
active_cmd:         .asciiz "ACTIVE"
completed_cmd:      .asciiz "COMPLETED"
transactions_cmd:   .asciiz "TRANSACTIONS"
reset_cmd:          .asciiz "RESET"
sync_cmd:           .asciiz "SYNC"
quit_cmd:           .asciiz "QUIT"

normal_type:        .asciiz "Normal"
ev_type:            .asciiz "EV"

entry_ok:           .asciiz "ENTRY_OK|"
exit_ok:            .asciiz "EXIT_OK|"

dashboard_text:     .asciiz "DASHBOARD|"
active_text:        .asciiz "ACTIVE|"
completed_text:     .asciiz "COMPLETED|"
transactions_text:  .asciiz "TRANSACTIONS|"

error_invalid:      .asciiz "ERROR|INVALID_COMMAND\n"
error_full:         .asciiz "ERROR|PARKING_FULL\n"
error_vehicle:      .asciiz "ERROR|VEHICLE_NOT_FOUND\n"
error_id:           .asciiz "ERROR|INVALID_PARKING_ID\n"
error_payment:      .asciiz "ERROR|INVALID_PAYMENT\n"
reset_ok:           .asciiz "RESET_OK\n"
sync_ok:            .asciiz "SYNC_OK\n"

.text
.globl main

# =========================================================
# MAIN LOOP
# =========================================================

main:

    li $v0, 4
    la $a0, ready_msg
    syscall

main_loop:

    # Read command
    li $v0, 8
    la $a0, command_buffer
    li $a1, 128
    syscall

    # Remove newline
    la $a0, command_buffer
    jal remove_newline

    # Check QUIT
    la $a0, command_buffer
    la $a1, quit_cmd
    jal string_equals
    beq $v0, 1, program_exit

    # Check ENTRY
    la $a0, command_buffer
    la $a1, entry_cmd
    jal starts_with
    beq $v0, 1, process_entry

    # Check EXIT
    la $a0, command_buffer
    la $a1, exit_cmd
    jal starts_with
    beq $v0, 1, process_exit

    # Check DASHBOARD
    la $a0, command_buffer
    la $a1, dashboard_cmd
    jal string_equals
    beq $v0, 1, show_dashboard

    # Check ACTIVE
    la $a0, command_buffer
    la $a1, active_cmd
    jal string_equals
    beq $v0, 1, show_active

    # Check COMPLETED
    la $a0, command_buffer
    la $a1, completed_cmd
    jal string_equals
    beq $v0, 1, show_completed

    # Check TRANSACTIONS
    la $a0, command_buffer
    la $a1, transactions_cmd
    jal string_equals
    beq $v0, 1, show_transactions

    # Check RESET
    la $a0, command_buffer
    la $a1, reset_cmd
    jal string_equals
    beq $v0, 1, reset_system

    # Check SYNC
    la $a0, command_buffer
    la $a1, sync_cmd
    jal starts_with
    beq $v0, 1, sync_system

    # Invalid command
    li $v0, 4
    la $a0, error_invalid
    syscall

    j main_loop


# =========================================================
# ENTRY
# Format:
# ENTRY|vehicle|Normal
# ENTRY|vehicle|EV
# =========================================================

process_entry:

    # Find first available slot
    jal find_free_slot

    move $s0, $v0

    # If -1, parking full
    li $t0, -1
    beq $s0, $t0, parking_full

    # Mark slot occupied
    la $t1, slots
    sll $t2, $s0, 2
    add $t1, $t1, $t2
    li $t3, 1
    sw $t3, 0($t1)

    # Get next parking ID
    lw $s1, next_parking_id

    addi $t4, $s1, 1
    sw $t4, next_parking_id

    # Increase active count
    lw $t5, active_count
    addi $t5, $t5, 1
    sw $t5, active_count

    # Store active record
    jal store_active_record

    # Output ENTRY_OK|parkingId|slot|vehicle|type
    li $v0, 4
    la $a0, entry_ok
    syscall

    li $v0, 1
    move $a0, $s1
    syscall

    li $v0, 4
    la $a0, pipe
    syscall

    li $v0, 1
    addi $a0, $s0, 1
    syscall

    li $v0, 4
    la $a0, pipe
    syscall

   # Vehicle text from command
la $a0, command_buffer
jal get_vehicle_from_command

# Save returned vehicle-buffer address
move $t9, $v0

li $v0, 4
move $a0, $t9
syscall
    li $v0, 4
    la $a0, newline
    syscall

    j main_loop


parking_full:

    li $v0, 4
    la $a0, error_full
    syscall

    j main_loop


# =========================================================
# EXIT
# Format:
# EXIT|parkingId|payment|fee
# =========================================================

process_exit:

    # Extract parking ID from command
    jal get_exit_parking_id
    move $s0, $v0

    # Validate parking ID
    jal find_active_record
    move $s1, $v0

    li $t0, -1
    beq $s1, $t0, invalid_parking_id

    # Extract payment
    jal get_exit_payment
    move $s2, $v0

    # Payment must be >= 0
    bltz $s2, invalid_payment

    # Get slot from active record
    la $t1, active_records
    li $t2, 16
    mul $t3, $s1, $t2
    add $t1, $t1, $t3

    lw $s3, 4($t1)

    # Mark slot available
    la $t4, slots
    sll $t5, $s3, 2
    add $t4, $t4, $t5
    sw $zero, 0($t4)

    # Store completed record
    jal store_completed_record

    # Remove active record
    jal remove_active_record

    # Decrease active count
    lw $t6, active_count
    addi $t6, $t6, -1
    sw $t6, active_count

    # Increase completed count
    lw $t7, completed_count
    addi $t7, $t7, 1
    sw $t7, completed_count

    # Increase transactions
    lw $t8, transaction_count
    addi $t8, $t8, 1
    sw $t8, transaction_count

    # Add revenue
    lw $t9, revenue
    add $t9, $t9, $s2
    sw $t9, revenue

    # Output EXIT_OK|parkingId|slot|payment
    li $v0, 4
    la $a0, exit_ok
    syscall

    li $v0, 1
    move $a0, $s0
    syscall

    li $v0, 4
    la $a0, pipe
    syscall

    li $v0, 1
    addi $a0, $s3, 1
    syscall

    li $v0, 4
    la $a0, pipe
    syscall

    li $v0, 1
    move $a0, $s2
    syscall

    li $v0, 4
    la $a0, newline
    syscall

    j main_loop


invalid_parking_id:

    li $v0, 4
    la $a0, error_id
    syscall

    j main_loop


invalid_payment:

    li $v0, 4
    la $a0, error_payment
    syscall

    j main_loop


# =========================================================
# FIND FREE SLOT
# Returns:
# v0 = slot index
# =========================================================

find_free_slot:

    li $t0, 0

find_slot_loop:

    bge $t0, 30, no_free_slot

    la $t1, slots
    sll $t2, $t0, 2
    add $t1, $t1, $t2
    lw $t3, 0($t1)

    beq $t3, $zero, free_slot_found

    addi $t0, $t0, 1
    j find_slot_loop

free_slot_found:

    move $v0, $t0
    jr $ra

no_free_slot:

    li $v0, -1
    jr $ra


# =========================================================
# STORE ACTIVE RECORD
# Record:
# 0 = parking ID
# 4 = slot
# 8 = payment
# 12 = active flag
# =========================================================

store_active_record:

    lw $t0, active_count
    addi $t0, $t0, -1

    li $t1, 16
    mul $t2, $t0, $t1

    la $t3, active_records
    add $t3, $t3, $t2

    sw $s1, 0($t3)
    sw $s0, 4($t3)
    sw $zero, 8($t3)
    li $t4, 1
    sw $t4, 12($t3)

    jr $ra


# =========================================================
# FIND ACTIVE RECORD
# Input:
# s0 = parking ID
# Returns:
# v0 = record index or -1
# =========================================================

find_active_record:

    lw $t0, active_count
    li $t1, 0

find_active_loop:

    bge $t1, $t0, active_not_found

    li $t2, 16
    mul $t3, $t1, $t2

    la $t4, active_records
    add $t4, $t4, $t3

    lw $t5, 0($t4)

    beq $t5, $s0, active_found

    addi $t1, $t1, 1
    j find_active_loop

active_found:

    move $v0, $t1
    jr $ra

active_not_found:

    li $v0, -1
    jr $ra


# =========================================================
# STORE COMPLETED RECORD
# =========================================================

store_completed_record:

    lw $t0, completed_count
    li $t1, 16
    mul $t2, $t0, $t1

    la $t3, completed_records
    add $t3, $t3, $t2

    sw $s0, 0($t3)
    sw $s3, 4($t3)
    sw $s2, 8($t3)
    sw $zero, 12($t3)

    jr $ra


# =========================================================
# REMOVE ACTIVE RECORD
# =========================================================

remove_active_record:

    lw $t0, active_count
    addi $t0, $t0, -1

    # Last record address
    li $t1, 16
    mul $t2, $t0, $t1

    la $t3, active_records
    add $t3, $t3, $t2

    # Removed record address
    li $t4, 16
    mul $t5, $s1, $t4

    la $t6, active_records
    add $t6, $t6, $t5

    # Copy last record into removed record
    lw $t7, 0($t3)
    sw $t7, 0($t6)

    lw $t7, 4($t3)
    sw $t7, 4($t6)

    lw $t7, 8($t3)
    sw $t7, 8($t6)

    lw $t7, 12($t3)
    sw $t7, 12($t6)

    jr $ra


# =========================================================
# DASHBOARD
# =========================================================

show_dashboard:

    lw $t0, active_count
    lw $t1, completed_count
    lw $t2, revenue

    li $t3, 30
    sub $t4, $t3, $t0

    li $v0, 4
    la $a0, dashboard_text
    syscall

    li $v0, 1
    li $a0, 30
    syscall

    li $v0, 4
    la $a0, pipe
    syscall

    li $v0, 1
    move $a0, $t4
    syscall

    li $v0, 4
    la $a0, pipe
    syscall

    li $v0, 1
    move $a0, $t0
    syscall

    li $v0, 4
    la $a0, pipe
    syscall

    li $v0, 1
    move $a0, $t0
    syscall

    li $v0, 4
    la $a0, pipe
    syscall

    li $v0, 1
    move $a0, $t1
    syscall

    li $v0, 4
    la $a0, pipe
    syscall

    li $v0, 1
    move $a0, $t2
    syscall

    li $v0, 4
    la $a0, newline
    syscall

    j main_loop


# =========================================================
# ACTIVE
# =========================================================

show_active:

    lw $t0, active_count

    li $v0, 4
    la $a0, active_text
    syscall

    li $v0, 1
    move $a0, $t0
    syscall

    li $v0, 4
    la $a0, newline
    syscall

    j main_loop


# =========================================================
# COMPLETED
# =========================================================

show_completed:

    lw $t0, completed_count

    li $v0, 4
    la $a0, completed_text
    syscall

    li $v0, 1
    move $a0, $t0
    syscall

    li $v0, 4
    la $a0, newline
    syscall

    j main_loop


# =========================================================
# TRANSACTIONS
# =========================================================

show_transactions:

    lw $t0, transaction_count
    lw $t1, revenue

    li $v0, 4
    la $a0, transactions_text
    syscall

    li $v0, 1
    move $a0, $t0
    syscall

    li $v0, 4
    la $a0, pipe
    syscall

    li $v0, 1
    move $a0, $t1
    syscall

    li $v0, 4
    la $a0, newline
    syscall

    j main_loop


# =========================================================
# SYNC SYSTEM
# Format:
# SYNC|nextParkingId|revenue|completedCount|transactionCount
#
# Used by server.js after a restart so MIPS remains the core
# counter/state engine while Node restores presentation data.
# =========================================================

sync_system:

    # Parse next parking ID
    jal get_sync_number_1
    sw $v0, next_parking_id

    # Parse revenue
    jal get_sync_number_2
    sw $v0, revenue

    # Parse completed count
    jal get_sync_number_3
    sw $v0, completed_count

    # Parse transaction count
    jal get_sync_number_4
    sw $v0, transaction_count

    # Active records are rebuilt by server.js afterwards.
    sw $zero, active_count

    # Clear all slots
    li $t0, 0
sync_clear_slots:
    bge $t0, 30, sync_done
    la $t1, slots
    sll $t2, $t0, 2
    add $t1, $t1, $t2
    sw $zero, 0($t1)
    addi $t0, $t0, 1
    j sync_clear_slots

sync_done:
    li $v0, 4
    la $a0, sync_ok
    syscall
    j main_loop

# ---------------------------------------------------------
# Generic number parser for SYNC fields.
# Field number is zero-based after "SYNC|".
# ---------------------------------------------------------

get_sync_number_1:
    li $t6, 1
    j get_sync_number

get_sync_number_2:
    li $t6, 2
    j get_sync_number

get_sync_number_3:
    li $t6, 3
    j get_sync_number

get_sync_number_4:
    li $t6, 4

get_sync_number:
    la $t0, command_buffer
    li $t1, 0

sync_find_field:
    lb $t2, 0($t0)
    beq $t2, $zero, sync_number_zero
    beq $t2, 124, sync_pipe_seen
    addi $t0, $t0, 1
    j sync_find_field

sync_pipe_seen:
    addi $t1, $t1, 1
    addi $t0, $t0, 1
    beq $t1, $t6, sync_number_start
    j sync_find_field

sync_number_start:
    li $t2, 0

sync_number_loop:
    lb $t3, 0($t0)
    beq $t3, $zero, sync_number_done
    beq $t3, 124, sync_number_done

    addi $t3, $t3, -48
    mul $t2, $t2, 10
    add $t2, $t2, $t3
    addi $t0, $t0, 1
    j sync_number_loop

sync_number_done:
    move $v0, $t2
    jr $ra

sync_number_zero:
    move $v0, $zero
    jr $ra

# =========================================================
# RESET SYSTEM
# =========================================================

reset_system:

    # Reset counters
    sw $zero, active_count
    sw $zero, completed_count
    sw $zero, transaction_count
    sw $zero, revenue

    li $t0, 1001
    sw $t0, next_parking_id

    # Clear all slots
    li $t1, 0

reset_slots_loop:

    bge $t1, 30, reset_done_slots

    la $t2, slots
    sll $t3, $t1, 2
    add $t2, $t2, $t3
    sw $zero, 0($t2)

    addi $t1, $t1, 1
    j reset_slots_loop

reset_done_slots:

    li $v0, 4
    la $a0, reset_ok
    syscall

    j main_loop


# =========================================================
# GET VEHICLE FROM ENTRY COMMAND
# =========================================================

# =========================================================
# GET VEHICLE FROM ENTRY COMMAND
# Input:
# ENTRY|ABC123|Normal
# Output:
# vehicle_buffer = ABC123
# v0 = address of vehicle_buffer
# =========================================================

get_vehicle_from_command:

    la $t0, command_buffer

# Skip ENTRY text
skip_entry_text:

    lb $t1, 0($t0)

    beq $t1, 124, vehicle_start

    addi $t0, $t0, 1
    j skip_entry_text

vehicle_start:

    addi $t0, $t0, 1

    la $t2, vehicle_buffer
    li $t3, 0

copy_vehicle_loop:

    lb $t1, 0($t0)

    beq $t1, 124, vehicle_copy_done
    beq $t1, 0, vehicle_copy_done

    sb $t1, 0($t2)

    addi $t0, $t0, 1
    addi $t2, $t2, 1
    addi $t3, $t3, 1

    blt $t3, 63, copy_vehicle_loop

vehicle_copy_done:

    sb $zero, 0($t2)

    la $v0, vehicle_buffer
    jr $ra

# =========================================================
# GET EXIT PARKING ID
# EXIT|1001|100
# =========================================================

get_exit_parking_id:

    la $t0, command_buffer

skip_exit_command:

    lb $t1, 0($t0)
    beq $t1, 124, found_id_start

    addi $t0, $t0, 1
    j skip_exit_command

found_id_start:

    addi $t0, $t0, 1
    li $t2, 0

parse_id_loop:

    lb $t1, 0($t0)

    beq $t1, 124, parse_id_done
    beq $t1, 0, parse_id_done

    addi $t1, $t1, -48
    mul $t2, $t2, 10
    add $t2, $t2, $t1

    addi $t0, $t0, 1
    j parse_id_loop

parse_id_done:

    move $v0, $t2
    jr $ra


# =========================================================
# GET EXIT PAYMENT
# =========================================================

get_exit_payment:

    la $t0, command_buffer
    li $t1, 0
    li $t2, 0

find_first_pipe:

    lb $t3, 0($t0)
    beq $t3, 124, first_pipe_found

    addi $t0, $t0, 1
    j find_first_pipe

first_pipe_found:

    addi $t0, $t0, 1

find_second_pipe:

    lb $t3, 0($t0)
    beq $t3, 124, second_pipe_found

    addi $t0, $t0, 1
    j find_second_pipe

second_pipe_found:

    addi $t0, $t0, 1
    li $t2, 0

parse_payment_loop:

    lb $t3, 0($t0)

    beq $t3, 0, parse_payment_done

    addi $t3, $t3, -48
    mul $t2, $t2, 10
    add $t2, $t2, $t3

    addi $t0, $t0, 1
    j parse_payment_loop

parse_payment_done:

    move $v0, $t2
    jr $ra


# =========================================================
# REMOVE NEWLINE
# =========================================================

remove_newline:

    move $t0, $a0

remove_newline_loop:

    lb $t1, 0($t0)

    beq $t1, 0, remove_newline_done
    beq $t1, 10, replace_newline
    beq $t1, 13, replace_newline

    addi $t0, $t0, 1
    j remove_newline_loop

replace_newline:

    sb $zero, 0($t0)

remove_newline_done:

    jr $ra


# =========================================================
# STRING EQUALS
# a0 = string 1
# a1 = string 2
# v0 = 1 equal, 0 not equal
# =========================================================

string_equals:

string_equals_loop:

    lb $t0, 0($a0)
    lb $t1, 0($a1)

    bne $t0, $t1, strings_not_equal

    beq $t0, $zero, strings_equal

    addi $a0, $a0, 1
    addi $a1, $a1, 1

    j string_equals_loop

strings_equal:

    li $v0, 1
    jr $ra

strings_not_equal:

    li $v0, 0
    jr $ra


# =========================================================
# STARTS WITH
# =========================================================

starts_with:

starts_with_loop:

    lb $t0, 0($a1)

    beq $t0, $zero, starts_with_yes

    lb $t1, 0($a0)

    bne $t0, $t1, starts_with_no

    addi $a0, $a0, 1
    addi $a1, $a1, 1

    j starts_with_loop

starts_with_yes:

    li $v0, 1
    jr $ra

starts_with_no:

    li $v0, 0
    jr $ra


# =========================================================
# PROGRAM EXIT
# =========================================================

program_exit:

    li $v0, 10
    syscall